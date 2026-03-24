import Anthropic from "@anthropic-ai/sdk";
import { registry as singletonRegistry } from "./tool-registry.js";
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
import { getModel } from "../config/models.js";
import type { ModelTier } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import { isAITurn, getActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { runScribe } from "./subagents/scribe.js";
import { promoteCharacter } from "./subagents/character-promotion.js";
import { searchCampaign } from "./subagents/search-campaign.js";
import { searchContent } from "./subagents/search-content.js";
import { norm } from "../utils/paths.js";
import { CampaignRepo, performRollback } from "../tools/git/index.js";
import { RollbackCompleteError, ContentRefusalError } from "../teardown.js";
import type { GitIO } from "../tools/git/index.js";
import { writeDebugDump } from "../tools/filesystem/debug-dump.js";
import { styleTheme } from "./subagents/theme-styler.js";
import { SCENE_TRACKER_CADENCE } from "./subagents/scene-tracker.js";
import { ResolveSession } from "./resolve-session.js";
import type { ActionDeclaration, StateDelta } from "../types/resolve-session.js";

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
  /** DM finished responding — full text available. playerAction is the tagged input that triggered this response. */
  onNarrativeComplete: (text: string, playerAction?: string) => void;
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
  /** Usage stats updated (delta from a single API call, with its model tier) */
  onUsageUpdate: (delta: UsageStats, tier: ModelTier) => void;
  /** Content classifier refused the response — clear partial DM output */
  onRefusal?: () => void;
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
    if (!last.content) return; // API rejects cache_control on empty text
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
    // Find the last non-empty text block to stamp cache_control on.
    // The API rejects cache_control on empty text blocks (e.g. from
    // fire-and-forget bail-out where tool_use blocks were stripped).
    const blocks = [...last.content] as unknown as Record<string, unknown>[];
    let stampIdx = blocks.length - 1;
    while (stampIdx >= 0) {
      const b = blocks[stampIdx];
      if (b.type === "text" && !(b.text as string)) {
        stampIdx--;
        continue;
      }
      break;
    }
    if (stampIdx < 0) return; // All blocks are empty text — nothing to stamp
    blocks[stampIdx] = {
      ...blocks[stampIdx],
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
  private pendingOOCSummary: string | null = null;
  private static MAX_AI_CHAIN = 10;
  private injectionRegistry: InjectionRegistry;
  private terminalDims: TerminalDims | undefined;
  private resolveSession: ResolveSession | null = null;

  /** Tracks the last failed input so the player can press Enter to retry. */
  private lastFailedInput: { characterName: string; text: string; opts?: { fromAI?: boolean; skipTranscript?: boolean } } | null = null;

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
    this.registry = singletonRegistry;
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

    // Wire persistence — fires for any dispatch (engine, OOC, dev mode)
    this.registry.persist = (state, slices) => {
      this.persistSlices(state, slices);
    };

    // Wire engine-specific tool hooks (combat lifecycle, player switching)
    this.registry.onToolSuccess = (toolName, state) => {
      if (toolName === "switch_player") {
        this.persistCurrentScene();
      }
      if (toolName === "start_combat") {
        void this.initResolveSession(state);
      } else if (toolName === "end_combat") {
        this.teardownResolveSession();
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
        case "objectives": this.persister.persistObjectives(state.objectives); break;
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

  /** Whether the engine has a failed input that can be retried with Enter. */
  hasPendingRetry(): boolean {
    return this.lastFailedInput !== null;
  }

  /**
   * Retry the last failed DM turn.
   * Used by the "Press Enter to retry" prompt after API errors.
   * Since the error occurred before the exchange was added to conversation,
   * we just replay processInput with the same arguments.
   */
  retryLastTurn(): void {
    const pending = this.lastFailedInput;
    if (!pending) return;
    // skipTranscript: true — transcript was already written on the original attempt
    this.processInput(pending.characterName, pending.text, { ...pending.opts, skipTranscript: true });
  }

  /**
   * Pop the last exchange from conversation and replay it.
   * Used by /retry to discard a bad DM response and try again.
   * Returns false if there's nothing to retry.
   */
  retryLastExchange(): boolean {
    const popped = this.conversation.popLastExchange();
    if (!popped) return false;
    // Extract character name and text from the stored user message
    const content = typeof popped.user.content === "string"
      ? popped.user.content
      : (popped.user.content as Anthropic.TextBlock[])
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
    // Tagged format is "[CharName] text" — optionally with OOC prefix
    const match = content.match(/(?:<ooc_summary>[\s\S]*?<\/ooc_summary>\s*)?(?:\[([^\]]+)\]\s*)([\s\S]*)/);
    if (!match) return false;
    const characterName = match[1];
    const text = match[2];
    // skipTranscript: true — the original transcript entry is already written
    this.processInput(characterName, text, { skipTranscript: true });
    return true;
  }

  /** Store a pending OOC summary to inject into the next DM turn (called from TUI layer on OOC exit). */
  setPendingOOCSummary(summary: string): void {
    this.pendingOOCSummary = this.pendingOOCSummary
      ? `${this.pendingOOCSummary}\n${summary}`
      : summary;
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

    // Tag the input with character name; prepend OOC summary if pending
    // (persisted in conversation history so the DM retains OOC context)
    let taggedInput = `[${characterName}] ${text}`;
    const consumedOOCSummary = this.pendingOOCSummary;
    if (consumedOOCSummary) {
      taggedInput = `<ooc_summary>\n${consumedOOCSummary}\n</ooc_summary>\n\n${taggedInput}`;
      this.pendingOOCSummary = null;
    }

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

      // Run scene tracker periodically to maintain open threads / NPC intents
      if (!opts?.skipTranscript) {
        const currentScene = this.sceneManager.getScene();
        const playerExchanges = currentScene.transcript.filter((t) => t.startsWith("**[")).length;
        if (playerExchanges > 0 && playerExchanges % SCENE_TRACKER_CADENCE === 0) {
          try {
            const trackerUsage = await this.sceneManager.runSceneTracker(this.client);
            accUsage(this.sessionUsage, trackerUsage);
            this.persistCurrentScene();
          } catch (e) {
            this.callbacks.onDevLog?.(`[dev] scene-tracker failed: ${e instanceof Error ? e.message : e}`);
          }
        }
      }

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
        } else if (cmd.type === "promote_character") {
          await this.handlePromoteCharacter(cmd);
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

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "large");

      // Notify completion — pass player action for context-aware choice generation
      this.callbacks.onNarrativeComplete(result.text, text || undefined);
      this.callbacks.onTurnEnd(dmTurn);

      // Clear any pending retry on success
      this.lastFailedInput = null;

    } catch (e) {
      if (e instanceof ContentRefusalError) {
        // Content classifier refusal — don't persist exchange or set retry
        // (same input would just re-trigger). Clear partial DM output and
        // show a gentle system message instead.
        if (consumedOOCSummary) {
          this.pendingOOCSummary = consumedOOCSummary;
        }
        // Still track usage — the API call cost money even though it was refused
        if (e.usage) {
          accUsage(this.sessionUsage, e.usage);
          this.callbacks.onUsageUpdate(e.usage, "large");
        }
        this.callbacks.onRefusal?.();
        this.callbacks.onTurnEnd(dmTurn);
      } else {
        // Restore consumed OOC summary so it retries on the next turn
        if (consumedOOCSummary) {
          this.pendingOOCSummary = consumedOOCSummary;
        }
        // Store the failed input so the player can press Enter to retry
        this.lastFailedInput = { characterName, text, opts };
        const error = e instanceof Error ? e : new Error(String(e));
        await this.dumpDebugInfo(error);
        this.callbacks.onError(error);
      }
    }

    this.setState("waiting_input");

    // Check if an AI player should auto-act next
    this.processAITurnIfNeeded();
  }

  /**
   * Execute a scene transition.
   */
  async transitionScene(title: string, timeAdvance?: number): Promise<void> {
    this.injectionRegistry.get<BehaviorInjection>("behavior")?.reset();
    this.setState("scene_transition");

    try {
      const result = await this.sceneManager.sceneTransition(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");

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
    this.injectionRegistry.get<BehaviorInjection>("behavior")?.reset();
    this.setState("session_ending");

    try {
      const result = await this.sceneManager.sessionEnd(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");

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
        this.callbacks.onUsageUpdate(result.usage, "small");
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

  /** Roll back to a previous git checkpoint and return to menu. */
  private async rollbackAndExit(target: string): Promise<void> {
    if (!this.repo) {
      this.callbacks.onError(new Error("Rollback unavailable: git is disabled for this campaign."));
      return;
    }
    this.callbacks.onDevLog?.(`[dev] rollback: rolling back to "${target}"`);
    const result = await performRollback(this.repo, target, this.gameState.campaignRoot, this.fileIO);
    this.callbacks.onTuiCommand?.({ type: "show_rollback_summary", summary: result.summary });
    throw new RollbackCompleteError(result.summary);
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
      this.callbacks.onUsageUpdate(result.usage, "small");
      this.callbacks.onDevLog?.(`[dev] scribe: ${result.summary}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] scribe: failed — ${msg}`);
    }
  }

  /** Handle promote_character tool — spawns subagent to update character sheet. */
  private async handlePromoteCharacter(cmd: TuiCommand): Promise<void> {
    const characterName = cmd.character as string;
    const context = cmd.context as string;
    if (!characterName) return;

    const paths = campaignPaths(this.gameState.campaignRoot);
    const filePath = norm(paths.character(characterName));

    try {
      // Read current sheet (may not exist for initial creation)
      let currentSheet = "";
      try {
        currentSheet = await this.fileIO.readFile(filePath);
      } catch {
        // New character — start from minimal template
        currentSheet = `# ${characterName}\n\n**Type:** character\n`;
      }

      // Skip if sheet was just built by post-setup (prevents duplicate sections).
      // Clear the flag so future level-ups still work.
      const { frontMatter: fm, body: fmBody, changelog: fmChangelog } = parseFrontMatter(currentSheet);
      if (fm.sheet_status === "complete") {
        delete fm.sheet_status;
        const title = fm._title ?? characterName;
        await this.fileIO.writeFile(filePath, serializeEntity(title, fm, fmBody, fmChangelog));
        const slug = characterName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        this.sceneManager.notifyEntityTouched(filePath, slug);
        this.callbacks.onDevLog?.(`[dev] promote_character: ${characterName} — skipped, sheet already complete`);
        return;
      }

      // Load system rules if available
      const ruleCard = await this.loadRuleCardCombat();

      const result = await promoteCharacter(this.client, {
        characterName,
        characterSheet: currentSheet,
        context,
        systemRules: ruleCard !== "No rule card available." ? ruleCard : undefined,
      });

      // Write the updated sheet
      if (result.updatedSheet) {
        await this.fileIO.writeFile(filePath, result.updatedSheet);
      }

      // Notify scene manager
      const slug = characterName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      this.sceneManager.notifyEntityTouched(filePath, slug);

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");
      this.callbacks.onDevLog?.(`[dev] promote_character: ${characterName} — ${result.changelogEntry}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] promote_character: failed — ${msg}`);
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
        this.callbacks.onUsageUpdate(result.usage, "small");

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
      const aiTier: ModelTier = active.player.model === "sonnet" ? "medium" : "small";
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, aiTier);

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
    return {
      model: this.model,
      maxTokens: TOKEN_LIMITS.DM_RESPONSE,
      maxToolRounds: 10,
      asyncToolHandler: (name, input) => this.handleAsyncTool(name, input),
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

  /** Handle tools that require async work (subagent spawning, I/O). */
  private async handleAsyncTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<import("./tool-registry.js").ToolResult | null> {
    if (name === "resolve_turn") {
      if (!this.resolveSession) {
        return {
          content: "No active combat session. Use start_combat first, or use roll_dice for non-combat checks.",
          is_error: true,
        };
      }
      const action: ActionDeclaration = {
        actor: input.actor as string,
        action: input.action as string,
        targets: input.targets as string[] | undefined,
        conditions: input.conditions as string | undefined,
      };
      try {
        const result = await this.resolveSession.resolve(action);
        this.applyResolutionDeltas(result.deltas);
        if (result.deltas.some(d => d.type === "hp_change" || d.type === "resource_spend")) {
          // Emit a resource refresh so the TUI's React effect persists the updated values
          this.callbacks.onTuiCommand({ type: "resource_refresh" });
        }
        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(result.usage, "small");
        this.callbacks.onDevLog?.(`[dev] resolve_turn: ${action.actor} — ${result.narrative.slice(0, 80)}`);
        // Emit resolution to the player so they always see the mechanical outcome,
        // regardless of whether the DM narrates it. This is visible in the TUI
        // as formatted text before the DM's narrative response.
        this.emitResolutionToPlayer(action.actor, result);
        return { content: this.formatResolutionForDM(result) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onDevLog?.(`[dev] resolve_turn: failed — ${msg}`);
        return { content: `Resolution failed: ${msg}`, is_error: true };
      }
    }

    const query = input.query as string;

    if (name === "search_campaign") {
      if (!query || !query.trim()) {
        return { content: "Query cannot be empty.", is_error: true };
      }

      try {
        const result = await searchCampaign(this.client, {
          query,
          campaignRoot: this.gameState.campaignRoot,
        }, this.fileIO);

        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(result.usage, "small");
        this.callbacks.onDevLog?.(`[dev] search_campaign: "${query}" → ${result.text.length} chars`);

        return { content: result.text };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onDevLog?.(`[dev] search_campaign: failed — ${msg}`);
        return { content: `Search failed: ${msg}`, is_error: true };
      }
    }

    if (name === "search_content") {
      if (!query || !query.trim()) {
        return { content: "Query cannot be empty.", is_error: true };
      }

      const systemSlug = this.gameState.config.system;
      if (!systemSlug) {
        return { content: "No game system configured for this campaign.", is_error: true };
      }

      try {
        const result = await searchContent(this.client, {
          query,
          systemSlug,
          homeDir: this.gameState.homeDir,
        }, this.fileIO);

        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(result.usage, "small");
        this.callbacks.onDevLog?.(`[dev] search_content: "${query}" → ${result.text.length} chars`);

        return { content: result.text };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onDevLog?.(`[dev] search_content: failed — ${msg}`);
        return { content: `Content search failed: ${msg}`, is_error: true };
      }
    }

    return null;
  }

  // --- Resolve Session Lifecycle ---

  /** Initialize the resolve session after combat starts. */
  private async initResolveSession(state: GameState): Promise<void> {
    try {
      const sheets = await this.loadCombatantSheets(state);
      const ruleCard = await this.loadRuleCardCombat();
      const mapSnapshot = this.buildMapSnapshot();

      this.resolveSession = new ResolveSession(this.client, this.fileIO, this.gameState);
      await this.resolveSession.initCombat(sheets, ruleCard, mapSnapshot || undefined);
      this.callbacks.onDevLog?.(`[dev] resolve_session: initialized for ${state.combat.order.length} combatants`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onDevLog?.(`[dev] resolve_session: init failed — ${msg}`);
      // Non-fatal — DM can still use roll_dice manually
    }
  }

  /** Tear down the resolve session when combat ends. */
  private teardownResolveSession(): void {
    if (this.resolveSession) {
      const summary = this.resolveSession.teardown();
      this.callbacks.onDevLog?.(`[dev] resolve_session: ${summary}`);
      this.resolveSession = null;
    }
  }

  /** Load character sheets for all combatants. */
  private async loadCombatantSheets(state: GameState): Promise<string> {
    const sheets: string[] = [];
    for (const entry of state.combat.order) {
      const paths = campaignPaths(state.campaignRoot);
      try {
        const content = await this.fileIO.readFile(norm(paths.character(entry.id)));
        if (content) {
          sheets.push(`### ${entry.id}\n${content}`);
          continue;
        }
      } catch {
        // Not a PC — might be an NPC/monster
      }
      sheets.push(`### ${entry.id}\nType: ${entry.type}, Initiative: ${entry.initiative}`);
    }
    return sheets.join("\n\n");
  }

  /** Load the combat-relevant section of the rule card. */
  private async loadRuleCardCombat(): Promise<string> {
    const systemSlug = this.gameState.config.system;
    if (!systemSlug) return "No game system configured.";

    // Try processed/copied rule card at ~/.machine-violet/systems/<slug>/
    try {
      const { processingPaths } = await import("../config/processing-paths.js");
      const paths = processingPaths(this.gameState.homeDir, systemSlug);
      const ruleCard = await this.fileIO.readFile(norm(paths.ruleCard));
      return ruleCard;
    } catch {
      // Fall back to bundled rule card (from repo systems/ directory)
      const { readBundledRuleCard } = await import("../config/systems.js");
      const content = readBundledRuleCard(systemSlug);
      return content ?? "No rule card available.";
    }
  }

  /** Build a compact map snapshot for the resolve session. */
  private buildMapSnapshot(): string | null {
    const mapKeys = Object.keys(this.gameState.maps);
    if (mapKeys.length === 0) return null;

    const lines: string[] = [];
    for (const key of mapKeys) {
      const map = this.gameState.maps[key];
      lines.push(`Map: ${key} (${map.bounds.width}x${map.bounds.height})`);
      if (map.entities) {
        for (const [coord, entities] of Object.entries(map.entities)) {
          for (const entity of entities) {
            lines.push(`  ${entity.id}: ${coord}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  /** Apply resolution deltas to game state. */
  private applyResolutionDeltas(deltas: StateDelta[]): void {
    for (const delta of deltas) {
      switch (delta.type) {
        case "hp_change":
        case "resource_spend": {
          // Update resource values for the target
          const target = delta.target;
          if (!this.gameState.resourceValues[target]) {
            this.gameState.resourceValues[target] = {};
          }
          const values = this.gameState.resourceValues[target];
          if (delta.type === "hp_change") {
            const amount = delta.details.amount as number;
            // Use the resource key from the delta (system-agnostic), or fall back
            // to the first display resource for backward compat with old deltas.
            const key = (delta.details.resource as string | undefined)
              ?? this.gameState.displayResources[target]?.[0]
              ?? "hp";
            const currentStr = values[key] ?? "0";
            const current = parseInt(currentStr, 10) || 0;
            values[key] = String(current + amount);
          } else {
            const resource = delta.details.resource as string;
            if (delta.details.remaining !== undefined) {
              values[resource] = String(delta.details.remaining);
            }
          }
          break;
        }
        case "condition_add":
        case "condition_remove":
        case "position_change":
          // These are logged in the narrative but don't directly map to
          // existing GameState fields. The DM reads them from the tool result.
          break;
      }
    }
  }

  /**
   * Look up a character's player color by actor name.
   * Returns the player's color if the actor is a PC, or null for NPCs/monsters.
   */
  private getActorColor(actor: string): string | null {
    const lower = actor.toLowerCase();
    const player = this.gameState.config.players.find(
      (p) => p.character.toLowerCase() === lower,
    );
    return player?.color ?? null;
  }

  /**
   * Emit the resolution result to the player via onNarrativeDelta.
   * PC rolls appear in the character's color; NPC rolls in muted grey.
   */
  private emitResolutionToPlayer(
    actor: string,
    result: import("../types/resolve-session.js").ResolutionResult,
  ): void {
    const lines: string[] = [];
    const actorColor = this.getActorColor(actor);
    const rollColor = actorColor ?? "#888888";
    const muteColor = "#666666";

    // Rolls — in actor's color for PCs, grey for NPCs
    for (const roll of result.rolls) {
      lines.push(`<color=${rollColor}>⚔ ${roll.reason}: ${roll.detail}</color>`);
    }

    // Outcome narrative
    if (result.narrative) {
      lines.push(`<i>${result.narrative}</i>`);
    }

    // State changes summary — always muted
    for (const delta of result.deltas) {
      if (delta.type === "hp_change") {
        const amt = delta.details.amount as number;
        const sign = amt >= 0 ? "+" : "";
        const key = (delta.details.resource as string | undefined) ?? "HP";
        lines.push(`<color=${muteColor}>${delta.target} ${key} ${sign}${amt}</color>`);
      } else if (delta.type === "condition_add") {
        lines.push(`<color=${muteColor}>${delta.target}: +${delta.details.condition}</color>`);
      } else if (delta.type === "condition_remove") {
        lines.push(`<color=${muteColor}>${delta.target}: -${delta.details.condition}</color>`);
      } else if (delta.type === "resource_spend") {
        lines.push(`<color=${muteColor}>${delta.target}: ${delta.details.resource} -${delta.details.spent}</color>`);
      }
    }

    if (lines.length > 0) {
      const headerColor = actorColor ?? muteColor;
      const block = `\n<color=${headerColor}>───── ${actor} ─────</color>\n${lines.join("\n")}\n`;
      this.callbacks.onNarrativeDelta(block);
    }
  }

  /** Format a ResolutionResult into a terse string for the DM's tool result. */
  private formatResolutionForDM(result: import("../types/resolve-session.js").ResolutionResult): string {
    const parts: string[] = [result.narrative];

    if (result.rolls.length > 0) {
      const rollLines = result.rolls.map(
        (r) => `${r.reason}: ${r.detail} = ${r.result}`,
      );
      parts.push(`Rolls: ${rollLines.join("; ")}`);
    }

    if (result.deltas.length > 0) {
      const deltaLines = result.deltas.map((d) => {
        const details = Object.entries(d.details)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        return `${d.type}(${d.target}): ${details}`;
      });
      parts.push(`Changes: ${deltaLines.join("; ")}`);
    }

    return parts.join("\n");
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


