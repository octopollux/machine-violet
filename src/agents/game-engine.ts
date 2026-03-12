import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import { ConversationManager } from "../context/conversation.js";
import type { DroppedExchange } from "../context/conversation.js";
import { narrativeLinesToMarkdown } from "../context/display-log.js";
import { StatePersister } from "../context/state-persistence.js";
import type { StateSlice } from "../context/state-persistence.js";
import { SceneManager } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import { InjectionRegistry, BehaviorInjection, ScenePacingInjection, LengthSteeringInjection } from "./injections.js";
import type { TerminalDims, InjectionContext } from "./injections.js";
import { processNarrativeLines } from "../tui/formatting.js";
import type { NarrativeLine } from "../types/tui.js";
import type { DMSessionState } from "./dm-prompt.js";
import { getModel, getThinkingConfig } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import type { ToolResult } from "./tool-registry.js";
import { isAITurn, getActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { runScribe } from "./subagents/scribe.js";
import { norm } from "../utils/paths.js";
import { CampaignRepo, performRollback } from "../tools/git/index.js";
import type { GitIO } from "../tools/git/index.js";
import { writeDebugDump } from "../tools/filesystem/debug-dump.js";
import { styleTheme } from "./subagents/theme-styler.js";

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
  private injectionRegistry: InjectionRegistry;
  private terminalDims: TerminalDims | undefined;
  /** Stashed tool_results from fire-and-forget TUI tools, prepended to next turn. */
  private pendingToolAcks: Anthropic.ToolResultBlockParam[] = [];

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
        // Snapshot current scene to disk so the commit captures the
        // true in-memory state. Display log is already append-flushed.
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

    // Set up injection registry
    this.injectionRegistry = new InjectionRegistry();
    this.injectionRegistry.register(new BehaviorInjection());
    this.injectionRegistry.register(new ScenePacingInjection());
    this.injectionRegistry.register(new LengthSteeringInjection());

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
    this.persister.persistConversation(this.conversation.getExchanges());
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

  /** Get persister (for shutdown and resume) */
  getPersister(): StatePersister | null {
    return this.persister;
  }

  /** Get campaign repo (for shutdown use) */
  getRepo(): CampaignRepo | null {
    return this.repo;
  }

  /** Seed the conversation with previously-persisted exchanges (for resume). */
  seedConversation(exchanges: import("../context/conversation.js").ConversationExchange[]): void {
    this.conversation.seedExchanges(exchanges);
  }

  /** Update the UI state section of the DM's prefix (called from TUI layer). */
  setUIState(uiState: string | undefined): void {
    this.sceneManager.getSessionState().uiState = uiState;
  }

  /** Update terminal dimensions for length steering (called from TUI layer on resize). */
  setTerminalDims(dims: TerminalDims): void {
    this.terminalDims = dims;
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
    // All injections (volatile context, behavioral reminders, scene pacing,
    // length steering) are prepended as a <context> block to the single user
    // message rather than using separate synthetic turns.
    const preambleParts: string[] = [];

    // Volatile context (Tier 3: activeState, entityIndex, uiState)
    if (volatileContext) {
      preambleParts.push(volatileContext);
    }

    // Registered injections (behavior, scene-pacing, length steering, etc.)
    const injCtx: InjectionContext = {
      conversationSize: this.conversation.size,
      scene: this.sceneManager.getScene(),
      skipTranscript: !!opts?.skipTranscript,
      terminalDims: this.terminalDims,
    };
    preambleParts.push(...this.injectionRegistry.buildAll(injCtx, this.callbacks.onDevLog));

    const preamble = preambleParts.length > 0
      ? `<context>\n${preambleParts.join("\n")}\n</context>\n\n`
      : "";

    // The API message includes the preamble; the stored exchange does not.
    // Volatile context and reminders are ephemeral per-turn injections that
    // should not persist in conversation history.
    //
    // If we have pending tool acks from a previous fire-and-forget bail-out,
    // prepend them so the API sees a tool_result for every prior tool_use.
    const userText = `${preamble}${taggedInput}`;
    let apiUserMessage: Anthropic.MessageParam;
    if (this.pendingToolAcks.length > 0) {
      apiUserMessage = {
        role: "user",
        content: [
          ...this.pendingToolAcks,
          { type: "text" as const, text: userText },
        ],
      };
      this.pendingToolAcks = [];
    } else {
      apiUserMessage = { role: "user", content: userText };
    }
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

      // Count wrapped lines for length steering, then update all injection counters
      let wrappedLineCount = 0;
      if (result.text && this.terminalDims) {
        // Approximate content width: subtract side frame chrome (~4 cols)
        const contentWidth = Math.max(1, this.terminalDims.columns - 4);
        const dmLines: NarrativeLine[] = result.text
          .split("\n")
          .map((line) => ({ kind: "dm" as const, text: line }));
        wrappedLineCount = processNarrativeLines(dmLines, contentWidth).length;
      }
      this.injectionRegistry.afterResponse({
        text: result.text,
        toolUsed: toolUsedThisTurn,
        fromAI: !!opts?.fromAI,
        wrappedLineCount,
      });

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

      // Persist display log and scene state after each exchange.
      // Writes are fire-and-forget for crash resilience; CampaignRepo's
      // preCommitHook flushes them to disk before any git commit.
      if (this.persister) {
        if (!opts?.skipTranscript) {
          const logLines: NarrativeLine[] = [
            { kind: "player", text: `[${characterName}] ${text}` },
          ];
          if (result.text) {
            logLines.push({ kind: "dm", text: result.text });
          }
          logLines.push({ kind: "dm", text: "" }); // paragraph separator
          this.persister.appendDisplayLog(narrativeLinesToMarkdown(logLines));
        }
        const scene = this.sceneManager.getScene();
        this.persister.persistScene({
          precis: scene.precis,
          openThreads: scene.openThreads || undefined,
          npcIntents: scene.npcIntents || undefined,
          playerReads: scene.playerReads,
          activePlayerIndex: this.gameState.activePlayerIndex,
        });
        this.persister.persistConversation(this.conversation.getExchanges());
      }

      // Track exchange for git auto-commit
      await this.repo?.trackExchange();

      // Handle dropped exchange — update precis, then re-persist scene
      // so the precis written to disk includes the just-dropped content.
      if (dropped) {
        this.callbacks.onExchangeDropped();
        await this.handleDroppedExchange(dropped);
        this.persistCurrentScene();
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
        } else if (cmd.type === "scribe") {
          await this.handleScribe(cmd);
        } else if (cmd.type === "dm_notes") {
          await this.handleDmNotes(cmd);
        } else if (cmd.type === "style_scene") {
          await this.handleStyleScene(cmd);
        } else if (cmd.type === "set_theme") {
          // Direct theme command (from location auto-apply, OOC, etc.)
          if (cmd.save_to_location) {
            await this.saveThemeToLocation(cmd);
          }
          this.callbacks.onTuiCommand(cmd);
        } else {
          this.callbacks.onTuiCommand(cmd);
        }
      }

      // Stash pending tool acks for next turn
      if (result.pendingToolAcks) {
        this.pendingToolAcks = result.pendingToolAcks;
      }

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Notify completion
      this.callbacks.onNarrativeComplete(result.text);
      this.callbacks.onTurnEnd(dmTurn);

    } catch (e) {
      // Clear pending acks on error — stale acks from a failed turn
      // would confuse the model on the next successful turn.
      this.pendingToolAcks = [];
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
    this.pendingToolAcks = []; // Scene transition resets conversation
    this.injectionRegistry.get<BehaviorInjection>("behavior")?.reset();
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
    this.pendingToolAcks = []; // Session end resets conversation
    this.injectionRegistry.get<BehaviorInjection>("behavior")?.reset();
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

  // --- Worldbuilding Entity I/O ---

  /** Spawn the scribe subagent to process batched entity updates */
  private async handleScribe(cmd: TuiCommand): Promise<void> {
    const updates = cmd.updates as { visibility: string; content: string }[];
    if (!updates || updates.length === 0) return;

    try {
      const sceneNumber = this.sceneManager.getScene().sceneNumber;
      const result = await runScribe(this.client, {
        updates: updates.map(u => ({
          visibility: u.visibility as "private" | "player-facing",
          content: u.content,
        })),
        campaignRoot: this.gameState.campaignRoot,
        sceneNumber,
      }, this.fileIO);

      // Notify scene manager about touched entities
      for (const filePath of [...result.created, ...result.updated]) {
        const slug = filePath.replace(/.*\//, "").replace(/\.md$/, "").replace(/\/index$/, "");
        this.sceneManager.notifyEntityTouched(filePath, slug);
      }

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);
      this.callbacks.onDevLog?.(`[dev] scribe: ${result.summary}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] scribe: failed — ${msg}`);
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

  // --- Theme styling ---

  /**
   * Handle a style_scene command from the DM.
   * If `description` is present, spawns a Haiku subagent to interpret
   * the natural-language request. Otherwise, dispatches directly.
   */
  private async handleStyleScene(cmd: TuiCommand): Promise<void> {
    const description = cmd.description as string | undefined;
    const directKeyColor = cmd.key_color as string | undefined;
    const variant = cmd.variant as string | undefined;

    let themeCmd: TuiCommand;

    if (description) {
      // Spawn theme stylist subagent
      this.callbacks.onDevLog?.(`[dev] style_scene: spawning theme-styler for "${description}"`);
      try {
        const result = await styleTheme(
          this.client,
          description,
          undefined, // current theme name not easily accessible here
          undefined, // current key color not easily accessible here
        );
        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(this.sessionUsage);

        if (!result.command) {
          this.callbacks.onDevLog?.("[dev] style_scene: subagent returned unparseable response, skipping");
          return;
        }

        themeCmd = result.command;
        this.callbacks.onDevLog?.(`[dev] style_scene: subagent chose theme=${themeCmd.theme ?? "(unchanged)"} key_color=${themeCmd.key_color ?? "(unchanged)"}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onDevLog?.(`[dev] style_scene: subagent failed — ${msg}`);
        return;
      }
    } else {
      // Direct mode — just forward key_color/variant
      themeCmd = { type: "set_theme" };
      if (directKeyColor) themeCmd.key_color = directKeyColor;
    }

    // Apply variant if specified (mechanical, no subagent needed)
    if (variant) themeCmd.variant = variant;

    // Persist to location entity if requested
    if (cmd.save_to_location) {
      await this.saveThemeToLocation({ ...themeCmd, save_to_location: true, location: cmd.location });
    }

    // Forward to TUI
    themeCmd.type = "set_theme";
    this.callbacks.onTuiCommand(themeCmd);
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
        conversationSize: this.conversation.size,
      });
      if (path) {
        this.callbacks.onDevLog?.(`[dev] debug dump saved: ${path}`);
      }
    } catch {
      // Debug dump itself failed — don't mask the original error
    }
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


