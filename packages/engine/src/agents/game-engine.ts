import { registry as singletonRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import type { LLMProvider, NormalizedMessage, ContentPart } from "../providers/types.js";
import { ConversationManager } from "../context/conversation.js";
import type { DroppedExchange } from "../context/conversation.js";
import { narrativeLinesToMarkdown } from "../context/display-log.js";
import { StatePersister } from "../context/state-persistence.js";
import type { StateSlice } from "../context/state-persistence.js";
import { SceneManager } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import { InjectionRegistry, BehaviorInjection, ScenePacingInjection, LengthSteeringInjection, HardStatsInjection } from "./injections.js";
import type { TerminalDims, InjectionContext } from "./injections.js";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";

/** Optional line-counting function for length steering.
 *  Defaults to a simple estimate if the TUI formatting pipeline isn't available. */
type LineCounter = (lines: NarrativeLine[], width: number) => { length: number };
let processNarrativeLines: LineCounter = (lines, width) => {
  // Simple estimate: count lines after wrapping at width
  let count = 0;
  for (const line of lines) {
    count += Math.max(1, Math.ceil(line.text.length / width));
  }
  return { length: count };
};

/** Inject the real TUI formatting pipeline for accurate length steering. */
export function setLineCounter(fn: LineCounter): void {
  processNarrativeLines = fn;
}
import type { DMSessionState } from "./dm-prompt.js";
import { getModel } from "../config/models.js";
import type { ModelTier } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { logEvent } from "../context/engine-log.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import type { ToolRegistry } from "./tool-registry.js";
import { isAITurn, getActivePlayer, getCombatActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { createChoiceGeneratorSession, shouldGenerateChoices } from "./subagents/choice-generator.js";
import type { ChoiceGeneratorSession } from "./subagents/choice-generator.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { runScribe } from "./subagents/scribe.js";
import { promoteCharacter } from "./subagents/character-promotion.js";
import { searchCampaign } from "./subagents/search-campaign.js";
import { searchContent } from "./subagents/search-content.js";
import { norm } from "../utils/paths.js";
import { CampaignRepo, performRollback } from "../tools/git/index.js";
import { RollbackCompleteError, ContentRefusalError } from "@machine-violet/shared/types/errors.js";
import type { GitIO } from "../tools/git/index.js";
import { writeDebugDump } from "../tools/filesystem/debug-dump.js";
import { styleTheme } from "./subagents/theme-styler.js";
import { SCENE_TRACKER_CADENCE } from "./subagents/scene-tracker.js";
import { ResolveSession } from "./resolve-session.js";
import type { ActionDeclaration, StateDelta } from "@machine-violet/shared/types/resolve-session.js";

// --- Types ---

import type { EngineState, TurnInfo, EngineCallbacks } from "@machine-violet/shared/types/engine.js";
export type { EngineState, TurnInfo, EngineCallbacks } from "@machine-violet/shared/types/engine.js";

/**
 * The game engine — orchestrates the DM agent, tools, TUI, and scene management.
 * This is the master state machine that drives gameplay.
 */
export class GameEngine {
  private provider: LLMProvider;
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

  /** Set while the DM turn is running if the DM called `present_choices` itself.
   *  Used to suppress auto-generated choices for that turn. */
  private dmProvidedChoicesThisTurn = false;

  /** Long-lived Haiku session for generating suggested responses.
   *  Lazy-initialized on first use, reset on scene transitions. */
  private choiceSession: ChoiceGeneratorSession | null = null;

  constructor(params: {
    provider: LLMProvider;
    gameState: GameState;
    scene: SceneState;
    sessionState: DMSessionState;
    fileIO: FileIO;
    callbacks: EngineCallbacks;
    model?: AgentLoopConfig["model"];
    gitIO?: GitIO;
    entityTree?: EntityTree;
  }) {
    this.provider = params.provider;
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
        // Snapshot current scene + transcript to disk so the commit
        // captures the true in-memory state.
        this.persistCurrentScene();
        await this.sceneManager.flushTranscript();
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
      params.entityTree,
    );
    this.callbacks = params.callbacks;
    this.model = params.model ?? getModel("large");

    // Set up injection registry
    this.injectionRegistry = new InjectionRegistry();
    this.injectionRegistry.register(new BehaviorInjection());
    this.injectionRegistry.register(new ScenePacingInjection());
    this.injectionRegistry.register(new LengthSteeringInjection());
    this.injectionRegistry.register(new HardStatsInjection());

    // Wire dev logging to scene manager
    this.sceneManager.devLog = params.callbacks.onDevLog;

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
      precis: scene.precis || null,
      openThreads: scene.openThreads || null,
      npcIntents: scene.npcIntents || null,

      playerReads: scene.playerReads,
      activePlayerIndex: this.gameState.activePlayerIndex,
      sessionRecapPending: scene.sessionRecapPending,
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

  /** Get the LLM provider (for subagent creation). */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /** Active mode session (OOC/Dev). Null when in normal play mode. */
  private modeSession: import("@machine-violet/shared/types/engine.js").ModeSession | null = null;
  /** Variant active before entering a mode session, for restoration on exit. */
  private previousVariant = "exploration";

  setModeSession(session: import("@machine-violet/shared/types/engine.js").ModeSession | null): void {
    this.modeSession = session;
  }

  getModeSession(): import("@machine-violet/shared/types/engine.js").ModeSession | null {
    return this.modeSession;
  }

  setPreviousVariant(variant: string): void {
    this.previousVariant = variant;
  }

  getPreviousVariant(): string {
    return this.previousVariant;
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
      : (popped.user.content as ContentPart[])
          .filter((b): b is ContentPart & { type: "text" } => b.type === "text")
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
    const turnStartTime = Date.now();
    this.dmProvidedChoicesThisTurn = false;
    logEvent("turn:player_input", { character: characterName, textLength: text.length });

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

    // Get system prompt (cached Tier 1+2), volatile context (Tier 3 soft),
    // and hard-stats string (Tier 3 hard). Pass the active character so the
    // DM sees an explicit "Turn: {name}" line in the stats block, reinforcing
    // whose decision it is and discouraging the DM from acting on the PC's
    // behalf.
    const { system: systemPrompt, volatile: volatileContext, hardStats: hardStatsText } = this.sceneManager.getSystemPrompt({
      turnHolder: characterName,
    });

    // Build message list
    const messages: NormalizedMessage[] = [...this.conversation.getMessages()];

    // Build the user message: player input with system-generated preamble.
    // All injections (volatile context, behavioral reminders, scene pacing,
    // length steering) are prepended as a <context> block to the single user
    // message rather than using separate synthetic turns.
    const preambleParts: string[] = [];

    // Volatile context (Tier 3: activeState, entityIndex, uiState)
    if (volatileContext) {
      preambleParts.push(volatileContext);
    }

    // Registered injections (behavior, scene-pacing, length steering,
    // hard-stats, etc.)
    const injCtx: InjectionContext = {
      conversationSize: this.conversation.size,
      scene: this.sceneManager.getScene(),
      skipTranscript: !!opts?.skipTranscript,
      terminalDims: this.terminalDims,
      hardStatsText,
    };
    preambleParts.push(...this.injectionRegistry.buildAll(injCtx, this.callbacks.onDevLog));

    const preamble = preambleParts.length > 0
      ? `<context>\n${preambleParts.join("\n")}\n</context>\n\n`
      : "";

    // The API message includes the preamble; the stored exchange does not.
    // Volatile context and reminders are ephemeral per-turn injections that
    // should not persist in conversation history.
    //
    // `ephemeral: true` tells the provider that this message's bytes won't be
    // present on subsequent turns (we store the stripped version). The
    // Anthropic provider uses that to stamp BP4 on the previous stable
    // message instead of this one, so next turn's cache lookup hits through
    // the stable tail and only pays for one turn's delta — not the entire
    // conversation tail.
    const apiUserMessage: NormalizedMessage = {
      role: "user",
      content: `${preamble}${taggedInput}`,
      ephemeral: preamble.length > 0,
    };
    const storedUserMessage: NormalizedMessage = {
      role: "user",
      content: taggedInput,
    };
    messages.push(apiUserMessage);

    // Wrap config to track tool calls this turn
    let toolCallCount = 0;
    const baseConfig = this.buildAgentConfig();
    const config: AgentLoopConfig = {
      ...baseConfig,
      onToolEnd: (name, result) => {
        toolCallCount++;
        baseConfig.onToolEnd?.(name, result);
      },
    };

    try {
      // Run the agent loop with streaming
      const result = await agentLoopStreaming(
        this.provider,
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
        toolUsed: toolCallCount > 0,
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
      let toolMessages: NormalizedMessage[] = [];
      let finalAssistantText = result.text;
      if (roundMsgs.length > 0) {
        const lastMsg = roundMsgs[roundMsgs.length - 1];
        if (roundMsgs.length > 1 && lastMsg.role === "assistant") {
          toolMessages = roundMsgs.slice(0, -1);
          // Extract text from only the final assistant to avoid duplicating
          // text that appeared in intermediate tool-use rounds
          finalAssistantText = typeof lastMsg.content === "string"
            ? lastMsg.content
            : (lastMsg.content as ContentPart[])
                .filter((b): b is ContentPart & { type: "text" } => b.type === "text")
                .map((b) => b.text)
                .join("");
        } else {
          // Truncated or single-message: keep all as tool context
          toolMessages = roundMsgs;
          finalAssistantText = "";
        }
      }

      // Add exchange to conversation manager (assistant kept as string for handleDroppedExchange compat)
      const assistantMessage: NormalizedMessage = {
        role: "assistant",
        content: finalAssistantText || result.text,
      };
      const dropped = this.conversation.addExchange(storedUserMessage, assistantMessage, toolMessages);

      // Persist display log and scene state after each exchange.
      // Writes are fire-and-forget for crash resilience; CampaignRepo's
      // preCommitHook flushes them to disk before any git commit.
      if (this.persister) {
        {
          const logLines: NarrativeLine[] = [];
          // Skip synthetic player input for system turns (session open/resume)
          // but always log the DM response so the opening narration is preserved.
          if (!opts?.skipTranscript) {
            // Turn separator before player input — restored as a styled
            // divider on session resume (matches the optimistic separator
            // the client injects during live play).
            logLines.push({ kind: "separator", text: "---" });
            logLines.push({ kind: "player", text: `[${characterName}] ${text}` });
          }
          if (result.text) {
            // Turn separator before DM narration (matches the client-side
            // separator injected on the first narrative:chunk after player input).
            if (!opts?.skipTranscript) {
              logLines.push({ kind: "separator", text: "---" });
            }
            logLines.push({ kind: "dm", text: result.text });
          }
          logLines.push({ kind: "dm", text: "" }); // paragraph separator
          this.persister.appendDisplayLog(narrativeLinesToMarkdown(logLines));
        }
        const scene = this.sceneManager.getScene();
        this.persister.persistScene({
          precis: scene.precis || null,
          openThreads: scene.openThreads || null,
          npcIntents: scene.npcIntents || null,
          playerReads: scene.playerReads,
          activePlayerIndex: this.gameState.activePlayerIndex,
          sessionRecapPending: scene.sessionRecapPending,
        });
        this.persister.persistConversation(this.conversation.getExchanges());
      }

      // Write transcript to disk so on-disk state always reflects the
      // completed DM turn. Without this, transcript.md is only written
      // during scene transitions, leaving it stale during normal play.
      await this.sceneManager.flushTranscript();

      // Track exchange for git auto-commit
      await this.repo?.trackExchange();

      // Run scene tracker periodically to maintain open threads / NPC intents
      if (!opts?.skipTranscript) {
        const currentScene = this.sceneManager.getScene();
        const playerExchanges = currentScene.transcript.filter((t) => t.startsWith("**[")).length;
        if (playerExchanges > 0 && playerExchanges % SCENE_TRACKER_CADENCE === 0) {
          try {
            const trackerUsage = await this.sceneManager.runSceneTracker(this.provider);
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

      // Process deferred TUI commands — only commands that need engine-side
      // work (scene transitions, subagent spawns, file I/O) remain here.
      // Visual-only commands (modeline, resources, choices, theme) were
      // already broadcast to the client immediately when the tool fired.
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
        } else if (cmd.type === "scribe") {
          await this.handleScribe(cmd);
        } else if (cmd.type === "promote_character") {
          await this.handlePromoteCharacter(cmd);
        } else if (cmd.type === "dm_notes") {
          await this.handleDmNotes(cmd);
        }
      }

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "large");

      logEvent("turn:dm_complete", {
        textLength: result.text.length,
        toolCalls: toolCallCount,
        rounds: result.roundMessages.filter((m) => m.role === "assistant").length,
        durationMs: Date.now() - turnStartTime,
      });

      // Notify completion — pass player action for context-aware choice generation
      this.callbacks.onNarrativeComplete(result.text, text || undefined);
      this.callbacks.onTurnEnd(dmTurn);

      // Auto-generate suggested responses for the next (human) turn when the
      // campaign's Choices Frequency is set above "never" and the DM didn't
      // already call `present_choices` itself. Fire-and-forget failures — the
      // turn itself has already succeeded, so we never want this to break it.
      void this.maybeGenerateSuggestedChoices(result.text, text, opts);

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
        logEvent("turn:error", {
          message: error.message,
          engineState: this.engineState,
          scene: this.sceneManager.getScene().sceneNumber,
          durationMs: Date.now() - turnStartTime,
        });
        await this.dumpDebugInfo(error);
        this.callbacks.onError(error);
      }
    }

    this.setState("waiting_input");

    // Check if an AI player should auto-act next
    this.processAITurnIfNeeded();
  }

  /**
   * Auto-generate suggested responses after a DM turn.
   *
   * Gated by the campaign's Choices Frequency setting (never/rarely/sometimes/often/always)
   * with an optional per-player override. Skipped when the DM already called
   * `present_choices`, when the turn was AI-driven, or when the next player is an AI.
   * Emitted as a synthetic `present_choices` TUI command so the bridge broadcasts it
   * on the existing choices:presented channel — no new wiring on the client.
   */
  private async maybeGenerateSuggestedChoices(
    narration: string,
    playerAction: string,
    opts?: { fromAI?: boolean; skipTranscript?: boolean },
  ): Promise<void> {
    if (opts?.skipTranscript) return;
    if (!narration || narration.length < 40) return;

    const choicesConfig = this.gameState.config.choices;
    if (!choicesConfig) return;

    // During combat, the next actor is determined by initiative — NPC turns
    // return null and should not receive suggested choices. Outside combat,
    // fall back to the free-play active player.
    const active = this.gameState.combat.active
      ? getCombatActivePlayer(this.gameState)
      : getActivePlayer(this.gameState);
    if (!active) return;
    if (active.isAI) return;

    const frequency =
      choicesConfig.player_overrides?.[active.characterName] ?? choicesConfig.campaign_default;

    if (!shouldGenerateChoices(frequency, this.dmProvidedChoicesThisTurn)) return;

    try {
      const session = await this.getOrCreateChoiceSession();
      const generated = await session.generate({
        narration,
        playerAction,
        volatileContext: this.buildChoiceVolatileContext(active.characterName),
        activeCharacterName: active.characterName,
      });
      accUsage(this.sessionUsage, generated.usage);
      this.callbacks.onUsageUpdate(generated.usage, "small");

      if (generated.choices.length === 0) return;

      this.callbacks.onTuiCommand({
        type: "present_choices",
        prompt: "",
        choices: generated.choices,
      });
    } catch (e) {
      this.callbacks.onDevLog?.(
        `[dev] choice-generator failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Lazy-init the long-lived Haiku choice session. Character sheets are loaded
   * once and baked into the cached system prompt prefix — we intentionally do
   * NOT refresh mid-session (character promotions show up in narration anyway,
   * and blowing away the cache on every tweak is not worth it).
   */
  private async getOrCreateChoiceSession(): Promise<ChoiceGeneratorSession> {
    if (this.choiceSession) return this.choiceSession;

    const sheets: string[] = [];
    for (const player of this.gameState.config.players) {
      const name = player.character;
      try {
        const sheetPath = campaignPaths(this.gameState.campaignRoot).character(name);
        const content = await this.fileIO.readFile(sheetPath);
        if (content && content.trim().length > 0) {
          sheets.push(content);
        }
      } catch (e) {
        // Missing sheet is fine (systemless play, freshly-created characters).
        // Anything else (permissions, I/O error) should surface in the dev log
        // instead of being swallowed silently.
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          this.callbacks.onDevLog?.(
            `[dev] choice-session: failed to read ${name} sheet: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    this.choiceSession = createChoiceGeneratorSession({
      provider: this.provider,
      characterSheets: sheets.join("\n\n---\n\n"),
      onRetry: (status, delayMs) => this.callbacks.onRetry(status, delayMs),
    });
    return this.choiceSession;
  }

  /**
   * Build the per-turn volatile `<context>` block for the choice generator.
   * Mirrors the DM's volatile-context pattern: ephemeral scene snapshot that
   * is injected into the API message but not persisted into the conversation.
   */
  private buildChoiceVolatileContext(activeCharacterName: string): string {
    const scene = this.sceneManager.getScene();
    const parts: string[] = [];
    if (scene.precis?.trim()) parts.push(`<scene_precis>\n${scene.precis.trim()}\n</scene_precis>`);
    if (scene.openThreads?.trim()) parts.push(`<open_threads>${scene.openThreads.trim()}</open_threads>`);
    if (scene.npcIntents?.trim()) parts.push(`<npc_intents>${scene.npcIntents.trim()}</npc_intents>`);
    parts.push(`<active_turn>${activeCharacterName}</active_turn>`);
    return `<context>\n${parts.join("\n")}\n</context>`;
  }

  /**
   * Execute a scene transition.
   */
  async transitionScene(title: string, timeAdvance?: number): Promise<void> {
    this.injectionRegistry.get<BehaviorInjection>("behavior")?.reset();
    this.injectionRegistry.get<HardStatsInjection>("hard-stats")?.reset();
    this.setState("scene_transition");

    try {
      const result = await this.sceneManager.sceneTransition(
        this.provider,
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

      // Reset the choice session so Haiku doesn't drag a full scene's worth of
      // user/assistant pairs across the cut. Reseed with the condensed campaign
      // log entry so cross-scene threads still carry forward.
      this.choiceSession?.reset(result.campaignLogEntry);

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
    this.injectionRegistry.get<HardStatsInjection>("hard-stats")?.reset();
    this.setState("session_ending");

    try {
      const result = await this.sceneManager.sessionEnd(
        this.provider,
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
    // sessionResume clears sessionRecapPending whenever it was set, regardless
    // of whether the recap files existed. Persist and await the flush so a
    // crash before the first turn cannot resurface the modal on next resume.
    // Persisting unconditionally is safe: when the flag was already false,
    // the write is a no-op for recap purposes.
    if (this.persister) {
      this.persistCurrentScene();
      await this.persister.flush();
    }
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
        this.provider,
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

    const subStart = Date.now();
    logEvent("subagent:start", { name: "scribe" });
    try {
      const sceneNumber = this.sceneManager.getScene().sceneNumber;
      const result = await runScribe(this.provider, {
        updates: updates.map(u => ({
          visibility: u.visibility as "private" | "player-facing",
          content: u.content,
        })),
        campaignRoot: this.gameState.campaignRoot,
        sceneNumber,
        entityTree: this.sceneManager.getEntityTree(),
        homeDir: this.gameState.homeDir,
      }, this.fileIO);

      // Apply entity tree deltas from Scribe
      if (result.entityDeltas) {
        for (const delta of result.entityDeltas) {
          this.sceneManager.upsertEntity(delta);
        }
      }

      logEvent("subagent:end", { name: "scribe", durationMs: Date.now() - subStart });
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");
      this.callbacks.onDevLog?.(`[dev] scribe: ${result.summary}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent("subagent:error", { name: "scribe", message: msg, durationMs: Date.now() - subStart });
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
    const subStart = Date.now();
    logEvent("subagent:start", { name: "promote_character", character: characterName });

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
        const title = String(fm._title ?? characterName);
        await this.fileIO.writeFile(filePath, serializeEntity(title, fm, fmBody, fmChangelog));
        const slug = characterName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        const relativePath = norm(filePath).replace(norm(this.gameState.campaignRoot) + "/", "");
        this.sceneManager.upsertEntity({ slug, name: characterName, aliases: [], type: "character", path: relativePath });
        this.callbacks.onDevLog?.(`[dev] promote_character: ${characterName} — skipped, sheet already complete`);
        return;
      }

      // Load system rules if available
      const ruleCard = await this.loadRuleCardCombat();

      const result = await promoteCharacter(this.provider, {
        characterName,
        characterSheet: currentSheet,
        context,
        systemRules: ruleCard !== "No rule card available." ? ruleCard : undefined,
      });

      // Write the updated sheet
      if (result.updatedSheet) {
        await this.fileIO.writeFile(filePath, result.updatedSheet);
      }

      // Update entity tree
      const slug = characterName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const relativePath = norm(filePath).replace(norm(this.gameState.campaignRoot) + "/", "");
      this.sceneManager.upsertEntity({ slug, name: characterName, aliases: [], type: "character", path: relativePath });

      logEvent("subagent:end", { name: "promote_character", durationMs: Date.now() - subStart });
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");
      this.callbacks.onDevLog?.(`[dev] promote_character: ${characterName} — ${result.changelogEntry}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent("subagent:error", { name: "promote_character", message: msg, durationMs: Date.now() - subStart });
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
  /**
   * Handle style_scene as an async tool — runs the theme-styler subagent
   * during tool execution so the theme update broadcasts immediately
   * (via _tui on the ToolResult) instead of after the DM turn.
   */
  private async handleStyleSceneTool(
    input: Record<string, unknown>,
  ): Promise<import("./tool-registry.js").ToolResult> {
    const description = input.description as string | undefined;
    const directKeyColor = input.key_color as string | undefined;
    const variant = input.variant as string | undefined;

    let themeCmd: TuiCommand;

    if (description) {
      // Spawn theme stylist subagent
      this.callbacks.onDevLog?.(`[dev] style_scene: spawning theme-styler for "${description}"`);
      try {
        const result = await styleTheme(
          this.provider,
          description,
          undefined, // current theme name not easily accessible here
          undefined, // current key color not easily accessible here
        );
        accUsage(this.sessionUsage, result.usage);
        this.callbacks.onUsageUpdate(result.usage, "small");

        if (!result.command) {
          this.callbacks.onDevLog?.("[dev] style_scene: subagent returned unparseable response, skipping");
          return { content: "Scene styled." };
        }

        themeCmd = result.command;
        this.callbacks.onDevLog?.(`[dev] style_scene: subagent chose theme=${themeCmd.theme ?? "(unchanged)"} key_color=${themeCmd.key_color ?? "(unchanged)"}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.callbacks.onDevLog?.(`[dev] style_scene: subagent failed — ${msg}`);
        return { content: "Scene styled." };
      }
    } else {
      // Direct mode — just forward key_color/variant
      themeCmd = { type: "set_theme" };
      if (directKeyColor) themeCmd.key_color = directKeyColor;
    }

    // Apply variant if specified (mechanical, no subagent needed)
    if (variant) themeCmd.variant = variant;

    // Persist to location entity if requested
    if (input.save_to_location) {
      await this.saveThemeToLocation({ ...themeCmd, save_to_location: true, location: input.location });
    }

    // Return set_theme as _tui so agent-loop-bridge broadcasts immediately
    themeCmd.type = "set_theme";
    return { content: "Scene styled.", _tui: themeCmd };
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
    } catch (e) {
      // Missing sheet is fine — systemless or freshly-created characters.
      // Other errors (permissions, I/O) surface in the dev log rather than
      // vanishing silently.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.callbacks.onDevLog?.(
          `[dev] ai-player: failed to read ${characterName} sheet: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Gather recent narration from conversation
    const messages = this.conversation.getMessages();
    const recentAssistant = messages
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    try {
      const result = await aiPlayerTurn(this.provider, {
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
      provider: this.provider,
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
      onTuiCommand: (cmd) => {
        // Immediate TUI commands (modeline, resources, choices, etc.)
        // are broadcast to the client as soon as the tool fires, so
        // visual updates appear mid-narration instead of after the turn.
        if (cmd.type === "present_choices") {
          this.dmProvidedChoicesThisTurn = true;
        }
        this.callbacks.onTuiCommand(cmd);
      },
      onRetry: (status, delayMs) => this.callbacks.onRetry(status, delayMs),
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

    if (name === "style_scene") {
      return this.handleStyleSceneTool(input);
    }

    const query = input.query as string;

    if (name === "search_campaign") {
      if (!query || !query.trim()) {
        return { content: "Query cannot be empty.", is_error: true };
      }

      try {
        const result = await searchCampaign(this.provider, {
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
        const result = await searchContent(this.provider, {
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

      this.resolveSession = new ResolveSession(this.provider, this.fileIO, this.gameState);
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
    result: import("@machine-violet/shared/types/resolve-session.js").ResolutionResult,
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
  private formatResolutionForDM(result: import("@machine-violet/shared/types/resolve-session.js").ResolutionResult): string {
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
        this.provider,
        dropped,
      );
      accUsage(this.sessionUsage, usage);
    } catch {
      // Non-critical — precis update failure doesn't break gameplay
    }
  }
}


