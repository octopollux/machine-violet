import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import { ConversationManager } from "../context/conversation.js";
import type { DroppedExchange, SerializedExchange } from "../context/conversation.js";
import { StatePersister } from "../context/state-persistence.js";
import type { StateSlice } from "../context/state-persistence.js";
import { SceneManager } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import { getModel } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import type { ToolResult } from "./tool-registry.js";
import { isAITurn, getActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { validateCampaign } from "../tools/validation/index.js";
import { CampaignRepo } from "../tools/git/index.js";
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
  private repo: CampaignRepo | null = null;
  private aiTurnDepth = 0;
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

    // Wire up state persistence
    this.persister = new StatePersister(
      params.gameState.campaignRoot,
      params.fileIO,
      (error) => this.callbacks.onError(error),
    );
    this.registry.onStateChanged = (_toolName, state, slices) => {
      this.persistSlices(state, slices);
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

    this.setState("dm_thinking");

    // Tag the input with character name
    const taggedInput = `[${characterName}] ${text}`;

    // Append to transcript (skip for system instructions like session open/resume)
    if (!opts?.skipTranscript) {
      this.sceneManager.appendPlayerInput(characterName, text);
    }

    // Build the user message
    const userMessage: Anthropic.MessageParam = {
      role: "user",
      content: taggedInput,
    };

    // Get system prompt
    const systemPrompt = this.sceneManager.getSystemPrompt();

    // Build message list; inject behavioral reminder before player input if needed
    const messages = [...this.conversation.getMessages()];
    if (!opts?.skipTranscript) {
      const reminder = this.buildBehaviorReminder();
      if (reminder) {
        messages.push({ role: "user", content: reminder });
      }
    }
    messages.push(userMessage);

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

      // Update behavioral drift counters
      if (toolUsedThisTurn) {
        this.turnsWithoutTools = 0;
      } else {
        this.turnsWithoutTools++;
      }
      const hasEntityLinks = /\[[^\]]+\]\([^)]+\.md[^)]*\)|\[\[[^\]]+\]\]/.test(result.text);
      if (hasEntityLinks) {
        this.turnsWithoutEntities = 0;
      } else {
        this.turnsWithoutEntities++;
      }

      // Append to transcript
      if (result.text) {
        this.sceneManager.appendDMResponse(result.text);
      }

      // Add exchange to conversation manager
      const assistantMessage: Anthropic.MessageParam = {
        role: "assistant",
        content: result.text,
      };
      const dropped = this.conversation.addExchange(userMessage, assistantMessage);

      // Persist conversation after each exchange (crash resilience)
      if (this.persister) {
        this.persister.persistConversation(this.conversation.serialize());
      }

      // Track exchange for git auto-commit
      await this.repo?.trackExchange();

      // Handle dropped exchange
      if (dropped) {
        this.callbacks.onExchangeDropped();
        await this.handleDroppedExchange(dropped);
      }

      // Persist scene state (precis, playerReads, activePlayerIndex)
      if (this.persister) {
        const scene = this.sceneManager.getScene();
        this.persister.persistScene({
          precis: scene.precis,
          openThreads: scene.openThreads || undefined,
          playerReads: scene.playerReads,
          activePlayerIndex: this.gameState.activePlayerIndex,
        });
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
        } else if (cmd.type === "context_refresh") {
          await this.refreshContext();
        } else if (cmd.type === "validate") {
          await this.runValidation();
        } else if (cmd.type === "create_entity") {
          await this.createEntity(cmd);
        } else if (cmd.type === "update_entity") {
          await this.updateEntity(cmd);
        } else {
          this.callbacks.onTuiCommand(cmd);
        }
      }

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Notify completion
      this.callbacks.onNarrativeComplete(result.text);

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
    const { entity_type, name, file_path, content } = cmd as {
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
      this.callbacks.onDevLog?.(`[dev] create_entity: wrote ${entity_type} "${name}" → ${filePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] create_entity: failed for "${name}" — ${msg}`);
    }
  }

  /** Update an existing entity file (from update_entity tool) */
  private async updateEntity(cmd: TuiCommand): Promise<void> {
    const { name, file_path, front_matter_updates, body_append, changelog_entry } = cmd as {
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
      this.callbacks.onDevLog?.(`[dev] update_entity: updated "${name}" — ${parts.join(", ")}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] update_entity: failed for "${name}" — ${msg}`);
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

      // Display AI action in narrative
      this.callbacks.onNarrativeDelta(`\n> ${characterName} (AI): ${result.action}\n`);

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
   * turns without using tools or wikilinks, otherwise null.
   * Injected ephemerally before the player message — not stored in conversation.
   */
  private buildBehaviorReminder(): string | null {
    if (this.conversation.size < GameEngine.BEHAVIOR_THRESHOLD) return null;
    const cues: string[] = [];
    if (this.turnsWithoutTools >= GameEngine.BEHAVIOR_THRESHOLD) cues.push("use your tools");
    if (this.turnsWithoutEntities >= GameEngine.BEHAVIOR_THRESHOLD) cues.push("wikilink entity names");
    if (cues.length === 0) return null;
    return `[dm-note] ${cues.join("; ")}.`;
  }

  private buildAgentConfig(): AgentLoopConfig {
    return {
      model: this.model,
      maxTokens: TOKEN_LIMITS.DM_RESPONSE,
      maxToolRounds: 10,
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

