import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import { ConversationManager } from "../context/conversation.js";
import type { DroppedExchange, SerializedExchange } from "../context/conversation.js";
import { StatePersister } from "../context/state-persistence.js";
import type { StateSlice } from "../context/state-persistence.js";
import { SceneManager, buildScenePacing } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import { getModel, getThinkingConfig } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import type { ToolResult } from "./tool-registry.js";
import { isAITurn, getActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { validateCampaign } from "../tools/validation/index.js";
import { CampaignRepo, performRollback } from "../tools/git/index.js";
import type { GitIO } from "../tools/git/index.js";
import { writeDebugDump } from "../tools/filesystem/debug-dump.js";

// --- Types ---

export type EngineState =
  | "idle"
  | "waiting_input"
  | "dm_thinking"
  | "tool_running"
  | "scene_transition"
  | "session_ending";

export interface TurnInfo {
  turnNumber: number;
  role: "player" | "dm" | "ai";
  participant: string;   // character name, or "DM"
  text: string;          // player/AI input text; empty string for DM turns
}

export interface EngineCallbacks {
  /** DM text streams in as it generates */
  onNarrativeDelta: (delta: string) => void;
  /** DM finished responding — full text available */
  onNarrativeComplete: (text: string) => void;
  /** Engine state changed (for activity indicators) */
  onStateChange: (state: EngineState) => void;
  /** TUI command from a tool call */
  onTuiCommand: (command: TuiCommand) => void;
  /** Tool started executing */
  onToolStart: (name: string) => void;
  /** Tool finished executing */
  onToolEnd: (name: string, result?: ToolResult) => void;
  /** Dev mode log message */
  onDevLog?: (msg: string) => void;
  /** Exchange dropped from conversation (precis will update) */
  onExchangeDropped: () => void;
  /** Usage stats updated */
  onUsageUpdate: (session: UsageStats) => void;
  /** Error occurred */
  onError: (error: Error) => void;
  /** API call is being retried after a retryable error */
  onRetry: (status: number, delayMs: number) => void;
  /** A player turn is starting (before any API work) */
  onTurnStart: (turn: TurnInfo) => void;
  /** A participant turn has ended */
  onTurnEnd: (turn: TurnInfo) => void;
}

/**
 * Stamp cache_control on the last content block of the last conversation
 * message (BP4). This lets the API cache the entire conversation prefix
 * so only the new user input is uncached.
 *
 * Intentionally omits `ttl` — the API default is 5 minutes, which is
 * appropriate since conversation changes every turn (unlike system/tools
 * which use 1h TTL).
 */
function stampConversationCache(messages: Anthropic.MessageParam[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") {
    // Convert string to block array so we can attach cache_control
    messages[messages.length - 1] = {
      role: last.role,
      content: [{
        type: "text" as const,
        text: last.content,
        cache_control: { type: "ephemeral" },
      } as Anthropic.TextBlockParam],
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = [...last.content] as unknown as Record<string, unknown>[];
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    };
    messages[messages.length - 1] = { role: last.role, content: blocks as unknown as Anthropic.ContentBlockParam[] };
  }
}

/**
 * The game engine — orchestrates the DM agent, tools, TUI, and scene management.
 * This is the master state machine that drives gameplay.
 */
export class GameEngine {
  private client: Anthropic;
  private registry: ToolRegistry;
  private gameState: GameState;
  private conversation: ConversationManager;
  private sceneManager: SceneManager;
  private callbacks: EngineCallbacks;
  private engineState: EngineState = "idle";
  private sessionUsage: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  };
  private model: AgentLoopConfig["model"];
  private persister: StatePersister | null;
  private fileIO: FileIO;
  private sessionState: DMSessionState;
  private repo: CampaignRepo | null = null;
  private aiTurnDepth = 0;
  private turnCounter = 0;
  private static MAX_AI_CHAIN = 10;
  private turnsWithoutTools = 0;
  private turnsWithoutEntities = 0;
  private static readonly BEHAVIOR_THRESHOLD = 3;

  constructor(params: {
    client: Anthropic;
    gameState: GameState;
    scene: SceneState;
    sessionState: DMSessionState;
    fileIO: FileIO;
    callbacks: EngineCallbacks;
    model?: AgentLoopConfig["model"];
    gitIO?: GitIO;
  }) {
    this.client = params.client;
    this.registry = new ToolRegistry();
    this.gameState = params.gameState;
    this.fileIO = params.fileIO;
    this.sessionState = params.sessionState;

    // Create CampaignRepo if gitIO provided
    if (params.gitIO) {
      this.repo = new CampaignRepo({
        dir: params.gameState.campaignRoot,
        git: params.gitIO,
        enabled: true,
        autoCommitInterval: params.gameState.config.recovery.auto_commit_interval,
        maxCommits: params.gameState.config.recovery.max_commits,
      });
    }

    // Wire persister flush into CampaignRepo so all state files are on disk
    // before any git commit (auto, scene, session, checkpoint).
    this.persister = new StatePersister(
      params.gameState.campaignRoot,
      params.fileIO,
      (error) => this.callbacks.onError(error),
    );
    if (this.repo) {
      const persister = this.persister;
      this.repo.preCommitHook = async () => {
        // Snapshot current conversation + scene to disk so the commit
        // captures the true in-memory state (including post-clear).
        persister.persistConversation(this.conversation.serialize());
        this.persistCurrentScene();
        await persister.flush();
      };
    }

    this.conversation = new ConversationManager(params.gameState.config.context);
    this.sceneManager = new SceneManager(
      params.gameState,
      params.scene,
      this.conversation,
      params.sessionState,
      params.fileIO,
      this.repo ?? undefined,
    );
    this.callbacks = params.callbacks;
    this.model = params.model ?? getModel("large");

    // Wire dev logging to scene manager when available
    if (params.callbacks.onDevLog) {
      this.sceneManager.devLog = params.callbacks.onDevLog;
    }

    // Wire up state change handlers
    this.registry.onStateChanged = (toolName, state, slices) => {
      this.persistSlices(state, slices);
      // switch_player mutates activePlayerIndex but has no state slice —
      // persist it via scene state immediately
      if (toolName === "switch_player") {
        this.persistCurrentScene();
      }
    };
  }

  /** Persist specific state slices after mutations */
  private persistSlices(state: GameState, slices: StateSlice[]): void {
    if (!this.persister) return;
    for (const slice of slices) {
      switch (slice) {
        case "combat": this.persister.persistCombat(state.combat); break;
        case "clocks": this.persister.persistClocks(state.clocks); break;
        case "maps": this.persister.persistMaps(state.maps); break;
        case "decks": this.persister.persistDecks(state.decks); break;
      }
    }
  }

  /** Persist current scene state (precis, threads, player index, etc.) */
  private persistCurrentScene(): void {
    if (!this.persister) return;
    const scene = this.sceneManager.getScene();
    this.persister.persistScene({
      precis: scene.precis,
      openThreads: scene.openThreads || undefined,
      npcIntents: scene.npcIntents || undefined,

      playerReads: scene.playerReads,
      activePlayerIndex: this.gameState.activePlayerIndex,
    });
  }

  /** Get current engine state */
  getState(): EngineState {
    return this.engineState;
  }

  /** Get session usage stats */
  getSessionUsage(): UsageStats {
    return { ...this.sessionUsage };
  }

  /** Get scene manager (for shutdown transcript flush) */
  getSceneManager(): SceneManager {
    return this.sceneManager;
  }

  /** Get conversation manager (for shutdown serialization) */
  getConversation(): ConversationManager {
    return this.conversation;
  }

  /** Get persister (for shutdown and resume) */
  getPersister(): StatePersister | null {
    return this.persister;
  }

  /** Get campaign repo (for shutdown use) */
  getRepo(): CampaignRepo | null {
    return this.repo;
  }

  /** Update the UI state section of the DM's prefix (called from TUI layer). */
  setUIState(uiState: string | undefined): void {
    this.sceneManager.getSessionState().uiState = uiState;
  }

  /** Hydrate conversation from saved exchanges */
  hydrateConversation(exchanges: SerializedExchange[]): void {
    this.conversation = ConversationManager.hydrate(exchanges, this.gameState.config.context);
    // Re-link scene manager to the new conversation instance
    this.sceneManager = new SceneManager(
      this.gameState,
      this.sceneManager.getScene(),
      this.conversation,
      this.sceneManager.getSessionState(),
      this.sceneManager.getFileIO(),
      this.repo ?? undefined,
    );
  }

  /**
   * Process player input: send to DM, stream response, handle tools.
   * This is the main game loop entry point.
   */
  async processInput(characterName: string, text: string, opts?: { fromAI?: boolean; skipTranscript?: boolean }): Promise<void> {
    if (this.engineState !== "idle" && this.engineState !== "waiting_input") {
      return; // Already processing
    }

    // Reset AI chain depth on human-initiated input
    if (!opts?.fromAI) {
      this.aiTurnDepth = 0;
    }

    // Fire player turn lifecycle (skipped for AI — executeAITurn already fired it,
    // and skipped for system instructions like session open/resume)
    if (!opts?.fromAI && !opts?.skipTranscript) {
      this.turnCounter++;
      const playerTurn: TurnInfo = {
        turnNumber: this.turnCounter,
        role: "player",
        participant: characterName,
        text,
      };
      this.callbacks.onTurnStart(playerTurn);
      this.callbacks.onTurnEnd(playerTurn);
    }

    // Fire DM turn lifecycle
    this.turnCounter++;
    const dmTurn: TurnInfo = {
      turnNumber: this.turnCounter,
      role: "dm",
      participant: "DM",
      text: "",
    };
    this.callbacks.onTurnStart(dmTurn);

    this.setState("dm_thinking");

    // Tag the input with character name
    const taggedInput = `[${characterName}] ${text}`;

    // Append to transcript (skip for system instructions like session open/resume)
    if (!opts?.skipTranscript) {
      this.sceneManager.appendPlayerInput(characterName, text);
    }

    // Get system prompt (cached Tier 1+2) and volatile context (Tier 3)
    const { system: systemPrompt, volatile: volatileContext } = this.sceneManager.getSystemPrompt();

    // Build message list; stamp conversation cache before new input
    const messages = [...this.conversation.getMessages()];
    stampConversationCache(messages);

    // Build the user message: player input with system-generated preamble.
    // All injections (volatile context, behavioral reminders, scene pacing)
    // are prepended as a <context> block to the single user message rather
    // than using separate synthetic turns.
    const preambleParts: string[] = [];

    // Volatile context (Tier 3: activeState, entityIndex, uiState)
    if (volatileContext) {
      preambleParts.push(volatileContext);
    }

    // Behavioral reminder
    if (!opts?.skipTranscript) {
      const reminder = this.buildBehaviorReminder();
      if (reminder) {
        preambleParts.push(reminder);
        this.callbacks.onDevLog?.(`[dev] injection: ${reminder}`);
      }
    }

    // Scene pacing every 3 exchanges
    if (this.conversation.size > 0 && this.conversation.size % 3 === 0) {
      const pacing = buildScenePacing(this.sceneManager.getScene());
      if (pacing) {
        preambleParts.push(`[scene-pacing] ${pacing}`);
      }
    }

    const preamble = preambleParts.length > 0
      ? `<context>\n${preambleParts.join("\n")}\n</context>\n\n`
      : "";

    // The API message includes the preamble; the stored exchange does not.
    // Volatile context and reminders are ephemeral per-turn injections that
    // should not persist in conversation history.
    const apiUserMessage: Anthropic.MessageParam = {
      role: "user",
      content: `${preamble}${taggedInput}`,
    };
    const storedUserMessage: Anthropic.MessageParam = {
      role: "user",
      content: taggedInput,
    };
    messages.push(apiUserMessage);

    // Wrap config to track whether any tool was called this turn
    let toolUsedThisTurn = false;
    const baseConfig = this.buildAgentConfig();
    const config: AgentLoopConfig = {
      ...baseConfig,
      onToolEnd: (name, result) => {
        toolUsedThisTurn = true;
        baseConfig.onToolEnd?.(name, result);
      },
    };

    try {
      // Run the agent loop with streaming
      const result = await agentLoopStreaming(
        this.client,
        systemPrompt,
        messages,
        this.registry,
        this.gameState,
        config,
      );

      // Update behavioral drift counters (only on human-initiated turns)
      if (!opts?.fromAI) {
        if (toolUsedThisTurn) {
          this.turnsWithoutTools = 0;
        } else {
          this.turnsWithoutTools++;
        }
        const hasEntityLinks = /<color=[^>]+>[^<]+<\/color>/.test(result.text);
        if (hasEntityLinks) {
          this.turnsWithoutEntities = 0;
        } else {
          this.turnsWithoutEntities++;
        }
      }

      // Append to transcript
      if (result.text) {
        this.sceneManager.appendDMResponse(result.text);
      }

      // Split round messages into tool interactions and final assistant.
      // When truncated, roundMessages may end with a user tool_result (no final assistant).
      const roundMsgs = result.roundMessages;
      let toolMessages: Anthropic.MessageParam[] = [];
      let finalAssistantText = result.text;
      if (roundMsgs.length > 0) {
        const lastMsg = roundMsgs[roundMsgs.length - 1];
        if (roundMsgs.length > 1 && lastMsg.role === "assistant") {
          toolMessages = roundMsgs.slice(0, -1);
          // Extract text from only the final assistant to avoid duplicating
          // text that appeared in intermediate tool-use rounds
          finalAssistantText = typeof lastMsg.content === "string"
            ? lastMsg.content
            : (lastMsg.content as Anthropic.ContentBlock[])
                .filter((b): b is Anthropic.TextBlock => b.type === "text")
                .map((b) => b.text)
                .join("");
        } else {
          // Truncated or single-message: keep all as tool context
          toolMessages = roundMsgs;
          finalAssistantText = "";
        }
      }

      // Add exchange to conversation manager (assistant kept as string for handleDroppedExchange compat)
      const assistantMessage: Anthropic.MessageParam = {
        role: "assistant",
        content: finalAssistantText || result.text,
      };
      const dropped = this.conversation.addExchange(storedUserMessage, assistantMessage, toolMessages);

      // Persist conversation and scene state after each exchange.
      // Writes are fire-and-forget for crash resilience; CampaignRepo's
      // preCommitHook flushes them to disk before any git commit.
      if (this.persister) {
        this.persister.persistConversation(this.conversation.serialize());
        const scene = this.sceneManager.getScene();
        this.persister.persistScene({
          precis: scene.precis,
          openThreads: scene.openThreads || undefined,
          npcIntents: scene.npcIntents || undefined,
          playerReads: scene.playerReads,
          activePlayerIndex: this.gameState.activePlayerIndex,
        });
      }

      // Track exchange for git auto-commit
      await this.repo?.trackExchange();

      // Handle dropped exchange
      if (dropped) {
        this.callbacks.onExchangeDropped();
        await this.handleDroppedExchange(dropped);
      }

      // Process TUI commands — intercept engine commands
      for (const cmd of result.tuiCommands) {
        if (cmd.type === "scene_transition") {
          await this.transitionScene(
            cmd.title as string,
            cmd.time_advance as number | undefined,
          );
        } else if (cmd.type === "session_end") {
          await this.endSession(
            cmd.title as string,
            cmd.time_advance as number | undefined,
          );
        } else if (cmd.type === "rollback") {
          await this.rollbackAndExit(cmd.target as string);
        } else if (cmd.type === "context_refresh") {
          await this.refreshContext();
        } else if (cmd.type === "validate") {
          await this.runValidation();
        } else if (cmd.type === "create_entity") {
          await this.createEntity(cmd);
        } else if (cmd.type === "update_entity") {
          await this.updateEntity(cmd);
        } else if (cmd.type === "dm_notes") {
          await this.handleDmNotes(cmd);
        } else if (cmd.type === "set_theme") {
          // Persist to location entity if requested, then forward to TUI
          if (cmd.save_to_location) {
            await this.saveThemeToLocation(cmd);
          }
          this.callbacks.onTuiCommand(cmd);
        } else {
          this.callbacks.onTuiCommand(cmd);
        }
      }

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Notify completion
      this.callbacks.onNarrativeComplete(result.text);
      this.callbacks.onTurnEnd(dmTurn);

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.dumpDebugInfo(error);
      this.callbacks.onError(error);
    }

    this.setState("waiting_input");

    // Check if an AI player should auto-act next
    this.processAITurnIfNeeded();
  }

  /**
   * Execute a scene transition.
   */
  async transitionScene(title: string, timeAdvance?: number): Promise<void> {
    this.turnsWithoutTools = 0;
    this.turnsWithoutEntities = 0;
    this.setState("scene_transition");

    try {
      const result = await this.sceneManager.sceneTransition(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Persist the reset scene state (new sceneNumber, cleared precis/transcript)
      this.persistCurrentScene();

      // Refresh context so the DM sees the updated campaign log
      await this.sceneManager.contextRefresh();

      // Auto-apply theme from location entity if it has theme metadata
      await this.applyLocationTheme(title);

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.dumpDebugInfo(error);
      this.callbacks.onError(error);
    }

    this.setState("waiting_input");
  }

  /**
   * End the session.
   */
  async endSession(title: string, timeAdvance?: number): Promise<void> {
    this.turnsWithoutTools = 0;
    this.turnsWithoutEntities = 0;
    this.setState("session_ending");

    try {
      const result = await this.sceneManager.sessionEnd(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Persist scene state after session end
      this.persistCurrentScene();

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.dumpDebugInfo(error);
      this.callbacks.onError(error);
    }

    this.setState("idle");
  }

  /**
   * Resume a session.
   */
  async resumeSession(): Promise<string> {
    const recap = await this.sceneManager.sessionResume();
    this.setState("waiting_input");
    return recap;
  }

  /**
   * Resume an interrupted scene-transition cascade from a pending operation.
   */
  async resumePendingTransition(pendingOp: import("./scene-manager.js").PendingOperation): Promise<void> {
    this.setState("scene_transition");

    try {
      const result = await this.sceneManager.resumePendingTransition(
        this.client,
        pendingOp,
      );

      if (result) {
        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(this.sessionUsage);
      }

      this.persistCurrentScene();
      await this.sceneManager.contextRefresh();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.dumpDebugInfo(error);
      this.callbacks.onError(error);
    }

    this.setState("waiting_input");
  }

  // --- Context Refresh ---

  /** Refresh the DM's context from disk */
  private async refreshContext(): Promise<void> {
    this.callbacks.onDevLog?.("[dev] context_refresh: refreshing context from disk");
    await this.sceneManager.contextRefresh();
    this.callbacks.onDevLog?.("[dev] context_refresh: done");
  }

  // --- Rollback ---

  /** Roll back to a previous git checkpoint and exit. */
  private async rollbackAndExit(target: string): Promise<void> {
    if (!this.repo) {
      this.callbacks.onError(new Error("Rollback unavailable: git is disabled for this campaign."));
      return;
    }
    this.callbacks.onDevLog?.(`[dev] rollback: rolling back to "${target}"`);
    const result = await performRollback(this.repo, target, this.gameState.campaignRoot, this.fileIO);
    console.log(`\nRolled back to: ${result.summary}\nRelaunch the game to resume from this point.\n`);
    process.exit(0);
  }

  // --- Validation ---

  /** Run campaign validation and surface results */
  private async runValidation(): Promise<void> {
    this.callbacks.onDevLog?.("[dev] validate: running campaign validation");
    try {
      const result = await validateCampaign(
        this.gameState.campaignRoot,
        this.gameState.maps,
        this.gameState.clocks,
        this.fileIO,
      );
      if (result.errorCount === 0 && result.warningCount === 0) {
        this.callbacks.onNarrativeDelta("[Validation: no issues found]\n");
      } else {
        const summary = result.issues
          .map((i) => `  ${i.severity}: ${i.file} — ${i.message}`)
          .join("\n");
        this.callbacks.onNarrativeDelta(
          `[Validation: ${result.errorCount} errors, ${result.warningCount} warnings]\n${summary}\n`,
        );
      }
      this.callbacks.onDevLog?.(`[dev] validate: ${result.errorCount} errors, ${result.warningCount} warnings, ${result.filesChecked} files checked`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] validate: failed — ${msg}`);
    }
  }

  // --- Worldbuilding Entity I/O ---

  /** Write a new entity file (from create_entity tool) */
  private async createEntity(cmd: TuiCommand): Promise<void> {
    const { entity_type, name, file_path, content } = cmd as unknown as {
      entity_type: string; name: string; file_path: string; content: string;
    };
    const filePath = norm(file_path);

    try {
      // Locations use subdirectories — ensure parent dir exists
      if (entity_type === "location") {
        const parentDir = filePath.replace(/\/index\.md$/, "");
        await this.fileIO.mkdir(parentDir);
      }

      if (await this.fileIO.exists(filePath)) {
        this.callbacks.onDevLog?.(`[dev] create_entity: "${name}" already exists at ${filePath}, skipping`);
        return;
      }

      await this.fileIO.writeFile(filePath, content);
      this.sceneManager.notifyEntityTouched(filePath, name);
      this.callbacks.onDevLog?.(`[dev] create_entity: wrote ${entity_type} "${name}" → ${filePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] create_entity: failed for "${name}" — ${msg}`);
    }
  }

  /** Update an existing entity file (from update_entity tool) */
  private async updateEntity(cmd: TuiCommand): Promise<void> {
    const { name, file_path, front_matter_updates, body_append, changelog_entry } = cmd as unknown as {
      name: string; file_path: string;
      front_matter_updates?: Record<string, unknown>;
      body_append?: string;
      changelog_entry?: string;
    };
    const filePath = norm(file_path);

    try {
      if (!(await this.fileIO.exists(filePath))) {
        this.callbacks.onDevLog?.(`[dev] update_entity: "${name}" not found at ${filePath}`);
        return;
      }

      const raw = await this.fileIO.readFile(filePath);
      const { frontMatter, body, changelog } = parseFrontMatter(raw);
      const title = frontMatter._title ?? name;
      const parts: string[] = [];

      // Merge front matter updates (null deletes keys)
      if (front_matter_updates) {
        for (const [key, value] of Object.entries(front_matter_updates)) {
          if (value === null) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete frontMatter[key];
          } else {
            frontMatter[key] = value;
          }
        }
        parts.push(`fm:${Object.keys(front_matter_updates).length} keys`);
      }

      // Append body text
      let newBody = body;
      if (body_append) {
        newBody = body ? `${body}\n\n${body_append}` : body_append;
        parts.push("+body");
      }

      // Add changelog entry
      const newChangelog = [...changelog];
      if (changelog_entry) {
        const sceneNumber = this.sceneManager.getScene().sceneNumber;
        newChangelog.push(formatChangelogEntry(sceneNumber, changelog_entry));
        parts.push("+changelog");
      }

      const updated = serializeEntity(title as string, frontMatter, newBody, newChangelog);
      await this.fileIO.writeFile(filePath, updated);

      const rawAliases = frontMatter.additional_names;
      const aliases = (Array.isArray(rawAliases) ? rawAliases.join(", ") : typeof rawAliases === "string" ? rawAliases : undefined)?.trim() || undefined;
      this.sceneManager.notifyEntityTouched(filePath, title as string, aliases);
      this.callbacks.onDevLog?.(`[dev] update_entity: updated "${name}" — ${parts.join(", ")}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] update_entity: failed for "${name}" — ${msg}`);
    }
  }

  /** Handle dm_notes tool (read/write campaign-scope DM notes) */
  private async handleDmNotes(cmd: TuiCommand): Promise<void> {
    const paths = campaignPaths(this.gameState.campaignRoot);
    const filePath = norm(paths.dmNotes);

    if (cmd.action === "read") {
      // Read is a no-op for the engine — notes are already in the prefix.
      // The tool result from the registry returns the TUI command; the actual
      // content is injected via DMSessionState.dmNotes in the cached prefix.
      this.callbacks.onDevLog?.("[dev] dm_notes: read (notes already in prefix)");
      return;
    }

    // Write
    const notes = (cmd.notes as string).trim();
    try {
      await this.fileIO.writeFile(filePath, notes);
      this.sessionState.dmNotes = notes;
      this.callbacks.onDevLog?.(`[dev] dm_notes: wrote ${notes.length} chars → ${filePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] dm_notes: write failed — ${msg}`);
    }
  }

  // --- Theme <-> Location persistence ---

  /** Save theme + key_color to a location entity's front matter. */
  private async saveThemeToLocation(cmd: TuiCommand): Promise<void> {
    const location = cmd.location as string | undefined;
    const themeName = cmd.theme as string | undefined;
    const keyColor = cmd.key_color as string | undefined;

    if (!location) {
      this.callbacks.onDevLog?.("[dev] set_theme: save_to_location requires a location name");
      return;
    }

    if (!themeName && !keyColor) {
      this.callbacks.onDevLog?.("[dev] set_theme: nothing to save (no theme or key_color provided)");
      return;
    }

    const slugified = location.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const paths = campaignPaths(this.gameState.campaignRoot);
    const filePath = norm(paths.location(slugified));

    try {
      if (!(await this.fileIO.exists(filePath))) {
        this.callbacks.onDevLog?.(`[dev] set_theme: location "${location}" not found at ${filePath}`);
        return;
      }

      const raw = await this.fileIO.readFile(filePath);
      const { frontMatter, body, changelog } = parseFrontMatter(raw);
      const title = frontMatter._title ?? location;

      if (themeName) frontMatter.theme = themeName;
      if (keyColor) frontMatter.key_color = keyColor;

      const sceneNumber = this.sceneManager.getScene().sceneNumber;
      const newChangelog = [...changelog];
      const parts: string[] = [];
      if (themeName) parts.push(`theme=${themeName}`);
      if (keyColor) parts.push(`key_color=${keyColor}`);
      newChangelog.push(formatChangelogEntry(sceneNumber, `Theme updated: ${parts.join(", ")}`));

      const updated = serializeEntity(title as string, frontMatter, body, newChangelog);
      await this.fileIO.writeFile(filePath, updated);
      this.callbacks.onDevLog?.(`[dev] set_theme: saved ${parts.join(", ")} to location "${location}"`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] set_theme: failed to save to location "${location}" — ${msg}`);
    }
  }

  /**
   * Check if a location entity has theme metadata and auto-apply it.
   * Called after scene transitions with the scene title as a location hint.
   */
  async applyLocationTheme(locationHint: string): Promise<void> {
    const slugified = locationHint.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const paths = campaignPaths(this.gameState.campaignRoot);
    const filePath = norm(paths.location(slugified));

    try {
      if (!(await this.fileIO.exists(filePath))) return;

      const raw = await this.fileIO.readFile(filePath);
      const { frontMatter } = parseFrontMatter(raw);
      const themeName = frontMatter.theme as string | undefined;
      const keyColor = frontMatter.key_color as string | undefined;

      if (themeName || keyColor) {
        const cmd: TuiCommand = { type: "set_theme" };
        if (themeName) cmd.theme = themeName;
        if (keyColor) cmd.key_color = keyColor;
        this.callbacks.onTuiCommand(cmd);
        this.callbacks.onDevLog?.(`[dev] auto-theme: applied ${themeName ?? ""}${keyColor ? ` ${keyColor}` : ""} from location "${locationHint}"`);
      }
    } catch {
      // Best-effort — don't break scene transitions for theme lookup failures
    }
  }

  // --- AI Auto-Turn ---

  /**
   * Check if the current turn belongs to an AI player.
   * If so, schedule executeAITurn via setTimeout(0) to keep the call stack flat.
   */
  processAITurnIfNeeded(): void {
    if (isAITurn(this.gameState)) {
      setTimeout(() => void this.executeAITurn(), 0);
    }
  }

  /**
   * Execute an AI player's turn: load character sheet, call AI subagent,
   * display the action, then feed it into processInput() as if the AI typed it.
   */
  async executeAITurn(): Promise<void> {
    // Safety valve — prevent infinite AI chains
    if (this.aiTurnDepth >= GameEngine.MAX_AI_CHAIN) {
      this.aiTurnDepth = 0;
      this.callbacks.onNarrativeDelta("\n[AI turn limit reached]\n");
      return;
    }

    this.aiTurnDepth++;

    const active = getActivePlayer(this.gameState);
    const characterName = active.characterName;

    this.setState("dm_thinking");

    // Load character sheet (best-effort)
    let characterSheet = `Character: ${characterName}`;
    try {
      const sheetPath = campaignPaths(this.gameState.campaignRoot).character(characterName);
      const content = await this.fileIO.readFile(sheetPath);
      if (content) characterSheet = content;
    } catch {
      // Fallback to name-only — fine for systemless play
    }

    // Gather recent narration from conversation
    const messages = this.conversation.getMessages();
    const recentAssistant = messages
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    try {
      const result = await aiPlayerTurn(this.client, {
        player: active.player,
        characterSheet,
        recentNarration: recentAssistant || "It's your turn. What do you do?",
      });

      // Fire AI player turn lifecycle
      this.turnCounter++;
      const aiTurn: TurnInfo = {
        turnNumber: this.turnCounter,
        role: "ai",
        participant: characterName,
        text: result.action,
      };
      this.callbacks.onTurnStart(aiTurn);
      this.callbacks.onTurnEnd(aiTurn);

      // Accumulate usage from subagent
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Feed the action into the game loop as player input
      await this.processInput(characterName, result.action, { fromAI: true });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.dumpDebugInfo(error);
      this.callbacks.onError(error);
      this.setState("waiting_input");
    }
  }

  // --- Internal ---

  private setState(state: EngineState): void {
    this.engineState = state;
    this.callbacks.onStateChange(state);
  }

  /** Write a debug dump with full context for post-mortem analysis. */
  private async dumpDebugInfo(error: Error): Promise<void> {
    try {
      const scene = this.sceneManager.getScene();
      const path = await writeDebugDump(this.gameState.campaignRoot, this.fileIO, {
        error,
        engineState: this.engineState,
        sceneNumber: scene.sceneNumber,
        sceneSlug: scene.slug,
        sessionNumber: scene.sessionNumber,
        precis: scene.precis,
        transcript: scene.transcript,
        conversation: this.conversation.serialize(),
      });
      if (path) {
        this.callbacks.onDevLog?.(`[dev] debug dump saved: ${path}`);
      }
    } catch {
      // Debug dump itself failed — don't mask the original error
    }
  }

  /**
   * Returns a terse behavioral reminder if the DM has gone BEHAVIOR_THRESHOLD
   * turns without using tools or formatting entities, otherwise null.
   * Injected ephemerally before the player message — not stored in conversation.
   */
  private buildBehaviorReminder(): string | null {
    if (this.conversation.size < GameEngine.BEHAVIOR_THRESHOLD) return null;
    const cues: string[] = [];
    if (this.turnsWithoutTools >= GameEngine.BEHAVIOR_THRESHOLD) cues.push("use your tools");
    if (this.turnsWithoutEntities >= GameEngine.BEHAVIOR_THRESHOLD) cues.push("color-code entity names");
    if (cues.length === 0) return null;
    return `[dm-note] ${cues.join("; ")}.`;
  }

  private buildAgentConfig(): AgentLoopConfig {
    const tc = getThinkingConfig("dm");
    return {
      model: this.model,
      maxTokens: TOKEN_LIMITS.DM_RESPONSE + tc.budgetTokens,
      maxToolRounds: 10,
      thinking: tc.param,
      onTextDelta: (delta) => this.callbacks.onNarrativeDelta(delta),
      onToolStart: (name) => {
        this.setState("tool_running");
        this.callbacks.onToolStart(name);
      },
      onToolEnd: (name, result) => {
        this.setState("dm_thinking");
        this.callbacks.onToolEnd(name, result);
      },
      onRetry: (status, delayMs) => {
        this.callbacks.onRetry(status, delayMs);
      },
    };
  }

  private async handleDroppedExchange(dropped: DroppedExchange): Promise<void> {
    try {
      const usage = await this.sceneManager.handleDroppedExchange(
        this.client,
        dropped,
      );
      accUsage(this.sessionUsage, usage);
    } catch {
      // Non-critical — precis update failure doesn't break gameplay
    }
  }
}


