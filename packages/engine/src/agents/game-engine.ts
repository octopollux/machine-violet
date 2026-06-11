import { registry as singletonRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { DM_TURN_LENGTH_PCT_DEFAULT } from "@machine-violet/shared/types/config.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import type { LLMProvider, NormalizedMessage, ContentPart, TierProvider } from "../providers/types.js";
import { GENERATE_IMAGE_TOOL_NAME, UPDATE_PORTRAIT_TOOL_NAME } from "../providers/types.js";
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
import type { ModelTier } from "../config/models.js";
import { accUsage } from "../context/usage-helpers.js";
import { logEvent } from "../context/engine-log.js";
import { withSpan, setSpanAttrs } from "../context/trace.js";
import { basename } from "node:path";
import { getMaxOutput } from "../config/model-registry.js";
import type { ToolRegistry } from "./tool-registry.js";
import { isAITurn, getActivePlayer, getCombatActivePlayer } from "./player-manager.js";
import { aiPlayerTurn } from "./subagents/ai-player.js";
import { createChoiceGeneratorSession, shouldGenerateChoices } from "./subagents/choice-generator.js";
import type { ChoiceGeneratorSession } from "./subagents/choice-generator.js";
import { campaignPaths, parseFrontMatter, serializeEntity, formatChangelogEntry } from "../tools/filesystem/index.js";
import { handleImageGenerated } from "./image-handler.js";
import { normalizeImageEffort, normalizeImageAspect } from "../providers/image-coerce.js";
import { loadDmPortraitMessage, loadCharacterReferences, commitPortraitRevision, downscalePortraitForContext, buildPortraitRevisionPrompt } from "./dm-portraits.js";
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
import { EntityStore } from "../entities/store.js";
import { buildEntityToolHandler, ENTITY_TOOL_NAME_SET } from "../entities/tools.js";
import type { ActionDeclaration, StateDelta } from "@machine-violet/shared/types/resolve-session.js";

// --- Types ---

import type { EngineState, TurnInfo, EngineCallbacks } from "@machine-violet/shared/types/engine.js";
export type { EngineState, TurnInfo, EngineCallbacks } from "@machine-violet/shared/types/engine.js";

/** Cap on an `update_portrait` change description — keeps the prompt, ack, and context marker bounded. */
const MAX_PORTRAIT_CHANGE_CHARS = 280;

/**
 * The game engine — orchestrates the DM agent, tools, TUI, and scene management.
 * This is the master state machine that drives gameplay.
 */
export class GameEngine {
  private provider: LLMProvider;
  /**
   * Per-tier resolved {provider, model} pairs. The DM uses `large`; subagents
   * pick `medium` or `small` per task. session-manager builds this from the
   * connections store at session start; tests construct a homogeneous map
   * via the `tierProvidersForTest` helper.
   */
  private tierProviders: Record<ModelTier, TierProvider>;
  private registry: ToolRegistry;
  private gameState: GameState;
  private conversation: ConversationManager;
  private sceneManager: SceneManager;
  private callbacks: EngineCallbacks;
  private engineState: EngineState = "idle";
  /** Count of in-flight `generate_image` tool calls. Image renders take minutes
   *  and run concurrently with faster sibling tools (scene_transition,
   *  style_scene); this keeps the "generating_image" activity state up for the
   *  whole render instead of letting a sibling's completion flip it to thinking.
   *  Reset to 0 at each turn start in case a render was abandoned mid-flight. */
  private imageGenInFlight = 0;
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
  /**
   * Entity store + dispatch handler — owns all file-backed entity I/O for
   * this session. Constructed once because the store caches its index/drift
   * scans and invalidates on writes. Lazy-init in `getEntityToolDispatcher`
   * so test sites that bypass agent dispatch don't pay for it.
   */
  private entityStore: EntityStore | null = null;
  private entityToolDispatcher: ((name: string, input: Record<string, unknown>) => Promise<import("./tool-registry.js").ToolResult | null>) | null = null;

  /** Tracks the last failed input so the player can press Enter to retry. */
  private lastFailedInput: { characterName: string; text: string; opts?: { fromAI?: boolean; skipTranscript?: boolean } } | null = null;

  /** Set while the DM turn is running if the DM called `present_choices` itself.
   *  Used to suppress auto-generated choices for that turn. */
  private dmProvidedChoicesThisTurn = false;

  /** Collected during a DM turn whenever a display_image TUI command fires
   *  (from generate_image). Appended to the display-log alongside the DM's
   *  text so the image survives session resume. Reset at the top of each
   *  player input. */
  private imagesEmittedThisTurn: { filename: string; intent: "scene_snapshot" | "player_request" | "character_portrait" }[] = [];

  /** Long-lived Haiku session for generating suggested responses.
   *  Lazy-initialized on first use, reset on scene transitions. */
  private choiceSession: ChoiceGeneratorSession | null = null;

  /**
   * Cached synthetic prefix message carrying PC portraits as `image_input`
   * ContentParts. Built lazily on first DM turn and held for the engine's
   * lifetime so portrait bytes don't re-read from disk every turn. Null
   * means "no portraits on disk for any PC" — the DM context proceeds
   * text-only. Invalidate by setting to undefined to trigger a rebuild
   * (e.g. after the setup agent writes a new portrait mid-campaign).
   */
  private cachedPortraitMessage: NormalizedMessage | null | undefined = undefined;

  /**
   * Revised PC portraits waiting to be handed back to the DM. When the DM
   * fires `update_portrait`, the render runs in the background; on completion
   * it pushes the downscaled new portrait here. The NEXT real player turn
   * folds these into its user message (the OOC-summary pattern) so the DM
   * sees the actual updated image — and it persists in that exchange — without
   * spending a dedicated turn or API call. Dropped on scene transition (the
   * prefix refresh carries the current portrait into the new scene).
   */
  private pendingPortraitInjections: { name: string; change: string; image: ContentPart }[] = [];

  /**
   * In-flight `update_portrait` renders. Tracked (not detached) so a failure
   * is logged rather than swallowed and so teardown can await them; the bytes
   * land on disk + the pointer swaps via the promise's own `.then`.
   */
  private inFlightPortraitRenders = new Set<Promise<void>>();

  /**
   * Serializes the archive+swap critical section across portrait revisions.
   * Renders run in parallel (each takes minutes), but two completing close
   * together for the same character would otherwise compute the same next
   * archive version (`listDir` + max + 1) and clobber history. Commits chain
   * through here so they run one-at-a-time; the chain swallows errors so one
   * failure never poisons later commits.
   */
  private portraitCommitChain: Promise<unknown> = Promise.resolve();

  /**
   * In-flight detached scribe(s). The scribe persists narrative events into
   * entity files; the DM never consumes its result, yet it is the single
   * largest chunk of player-facing turn latency (~half of an entity-heavy
   * turn). So it runs fire-and-forget off the turn's critical path.
   *
   * Chained, not parallelized: consecutive scribes must serialize, because
   * scribe N's entity-tree deltas have to land before scribe N+1 reads the
   * tree for dedup. `awaitPendingScribe()` is the barrier at every point that
   * reads or snapshots durable entity state — the next turn's context build,
   * scene transition, session end, rollback — and the seam tests/teardown use
   * to settle background work deterministically. The chain swallows errors so
   * one failed scribe never poisons a later one or a barrier await.
   *
   * TODO(perf/maintainability): generalize this single-task chain into a
   * deferred-work registry — lanes (serial/parallel) × barrier points, each lane
   * declaring its "deferral horizon" (which barriers it must settle at). Scribe
   * is write-only → all barriers are cold; scene-tracker is write-back →
   * next-ctx barrier is hot; choices gen → no engine barrier. One `settle(point)`
   * per barrier covers every lane, so adding work or a consistency point can't
   * silently miss a barrier (cf. the `promote_character` barrier we only caught
   * in review). Attribute a *blocked* settle() as a `barrier_wait` span so the
   * flame chart measures the real overrun rate instead of us guessing it.
   */
  private pendingScribe: Promise<void> = Promise.resolve();

  constructor(params: {
    provider: LLMProvider;
    gameState: GameState;
    scene: SceneState;
    sessionState: DMSessionState;
    fileIO: FileIO;
    callbacks: EngineCallbacks;
    /**
     * Per-tier {provider, model} map — the routing table for every model call
     * the engine makes. The DM uses `large`; subagents pick `medium` or `small`
     * per task. Required because under heterogeneous routing (different vendors
     * per tier) any silent fallback to `params.provider` would send the wrong
     * model ID through the wrong client. The DM's model ID is read from
     * `tierProviders.large.model`; there is no separate `model` param. Tests
     * synthesize a homogeneous map via `tierProvidersForTest`.
     */
    tierProviders: Record<ModelTier, TierProvider>;
    gitIO?: GitIO;
    entityTree?: EntityTree;
  }) {
    this.provider = params.provider;
    this.tierProviders = params.tierProviders;
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
      this.tierProviders,
    );
    this.callbacks = params.callbacks;
    this.model = params.tierProviders.large.model;

    // Set up injection registry
    this.injectionRegistry = new InjectionRegistry();
    this.injectionRegistry.register(new BehaviorInjection());
    this.injectionRegistry.register(new ScenePacingInjection());
    const lengthInjection = new LengthSteeringInjection();
    // Route the "no viewport reported" fallback warning through the same
    // dev-log channel so it surfaces alongside other injection traces
    // instead of going to stderr. Only override when onDevLog is
    // actually wired — otherwise leave the injection's default
    // console.warn fallback in place so the warning isn't silently
    // dropped in environments (tests, headless dev) that don't supply
    // onDevLog.
    if (params.callbacks.onDevLog) {
      const onDevLog = params.callbacks.onDevLog;
      lengthInjection.setWarnFn((msg) => onDevLog(msg));
    }
    this.injectionRegistry.register(lengthInjection);
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
      if (toolName === "swap_pc") {
        // swap_pc rewrites the PC roster (config.players) and the active
        // index. Both must reach disk or the next load resurrects the old PC.
        this.persister?.persistConfig(state.config);
        this.persistCurrentScene();
      }
      if (toolName === "swap_dm_personality") {
        // swap_dm_personality rewrites config.dm_personality. buildDMPrefix
        // reads it live each turn, so the new voice is in play next turn;
        // persist so it also survives a reload.
        this.persister?.persistConfig(state.config);
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

  /**
   * Get the resolved {provider, model} for a given tier. Subagent dispatch
   * sites that live outside the engine (command-handler, etc.) call this to
   * pick the right pair without having to know about tierProviders directly.
   */
  getTier(tier: ModelTier): TierProvider {
    return this.tierProviders[tier];
  }

  /** Get the engine's FileIO (campaign-root anchored). OOC/Dev reuse it. */
  getFileIO(): FileIO {
    return this.fileIO;
  }

  /** Get live game state. OOC dispatches tools against this same object. */
  getGameState(): GameState {
    return this.gameState;
  }

  /** Get the tool registry the DM uses. OOC dispatches through the same singleton. */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * Async tool handler exposed for mode sessions (OOC/Dev) that want to
   * reuse the DM's async tool surface (resolve_turn, search_campaign,
   * search_content, style_scene). Returns null for tools the handler
   * doesn't cover — callers should fall back to `registry.dispatch`.
   */
  handleAsyncTool(name: string, input: Record<string, unknown>): Promise<import("./tool-registry.js").ToolResult | null> {
    return this.handleAsyncToolInternal(name, input);
  }

  /**
   * Forward an immediate (non-deferred) TUI command through the same
   * pipeline DM tool calls use — broadcasts to the client and updates
   * persisted UI state. Exposed so OOC/Dev's immediate TUI tool calls
   * (style_scene, update_modeline, set_resource_values, etc.) reach the
   * client just like the DM's.
   */
  dispatchImmediateTuiCommand(cmd: TuiCommand): void {
    this.callbacks.onTuiCommand(cmd);
  }

  /**
   * Process a batch of deferred TUI commands (scribe, promote_character,
   * dm_notes, scene_transition, session_end, rollback) the same way the DM
   * does after its agent loop completes. Exposed so OOC can share the
   * exact same teardown semantics. May throw RollbackCompleteError.
   */
  async applyDeferredTuiCommands(commands: TuiCommand[]): Promise<void> {
    for (const cmd of commands) {
      if (cmd.type === "scene_transition") {
        await this.transitionScene(cmd.title as string, cmd.time_advance as number | undefined);
      } else if (cmd.type === "session_end") {
        await this.endSession(cmd.title as string, cmd.time_advance as number | undefined);
      } else if (cmd.type === "rollback") {
        await this.rollbackAndExit(cmd.target as string);
      } else if (cmd.type === "scribe") {
        // Detached: the DM doesn't need the scribe's result to keep narrating,
        // and the scribe is ~half of player-facing turn latency. Chain (not
        // parallelize) so scribes serialize — dedup needs scribe N's tree
        // deltas applied before scribe N+1 reads. The `.catch` keeps a failed
        // scribe from poisoning the chain or a later barrier await
        // (handleScribe already swallows its own errors — belt & braces). The
        // barrier in transitionScene/endSession/rollback (and at the next
        // turn's start) flushes this before any durable entity read.
        this.pendingScribe = this.pendingScribe
          .catch(() => undefined)
          .then(() => this.handleScribe(cmd));
      } else if (cmd.type === "promote_character") {
        await this.handlePromoteCharacter(cmd);
      } else if (cmd.type === "dm_notes") {
        await this.handleDmNotes(cmd);
      } else if (cmd.type === "present_choices") {
        // `present_choices` is in DEFERRED_TUI_TYPES so the modal lands
        // after the DM's prose (matters for codex/GPT-5.5, which emits
        // all tool calls before any text). Re-broadcast through the same
        // onTuiCommand sink the bridge would have used immediately for a
        // non-deferred command.
        this.callbacks.onTuiCommand?.(cmd);
      }
    }
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
   * Campaign slug used to tag trace spans — the campaign directory basename,
   * matching how campaign-explorer keys campaigns (`?campaign=<slug>`).
   */
  private get campaignId(): string {
    return basename(norm(this.gameState.campaignRoot));
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

    this.imageGenInFlight = 0;
    this.setState("dm_thinking");

    // Barrier: the previous turn's scribe runs detached (see `pendingScribe`).
    // Flush it before reading entity state for this turn — the DM context
    // (entity registry + character sheets) and the next scribe's dedup both
    // need the prior writes landed, and a concurrent read could otherwise tear
    // a half-written sheet. Placed AFTER `setState("dm_thinking")` so the
    // re-entrancy guard above is already armed before we yield on the await;
    // usually a no-op, since the player's think-time dwarfs the scribe.
    await this.awaitPendingScribe();

    const turnStartTime = Date.now();
    this.dmProvidedChoicesThisTurn = false;
    this.imagesEmittedThisTurn = [];
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

    // Build message list. When PC portraits exist on disk and the
    // provider supports image input, prepend a synthetic non-ephemeral
    // user message carrying them as image_input ContentParts. The
    // message sits inside the BP4 cached prefix, so portraits cost
    // tokens once per cache write rather than every turn. Helper
    // tolerates missing portraits silently — campaigns that skipped
    // chargen portraits run text-only without throwing.
    if (this.cachedPortraitMessage === undefined) {
      this.cachedPortraitMessage = await loadDmPortraitMessage(
        this.gameState.config.players,
        this.fileIO,
        this.gameState.campaignRoot,
      );
    }
    const messages: NormalizedMessage[] = this.cachedPortraitMessage
      ? [this.cachedPortraitMessage, ...this.conversation.getMessages()]
      : [...this.conversation.getMessages()];

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
      dmTurnLengthPct: this.gameState.config.dm_turn_length_pct ?? DM_TURN_LENGTH_PCT_DEFAULT,
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
    // Revised portraits that finished rendering since the last turn ride into
    // THIS turn's user message as image_input parts — the DM sees the actual
    // updated likeness for free (no dedicated turn), and they persist in the
    // stored exchange so they replay through the rest of the scene. See the
    // `pendingPortraitInjections` field and `dispatchUpdatePortrait`.
    const portraitParts = this.consumePendingPortraitInjections();
    const apiUserMessage: NormalizedMessage = {
      role: "user",
      content: portraitParts.length > 0
        ? [...portraitParts, { type: "text", text: `${preamble}${taggedInput}` }]
        : `${preamble}${taggedInput}`,
      ephemeral: preamble.length > 0,
    };
    const storedUserMessage: NormalizedMessage = {
      role: "user",
      content: portraitParts.length > 0
        ? [...portraitParts, { type: "text", text: taggedInput }]
        : taggedInput,
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

    // Root turn span: the wall-clock envelope the flame chart segments on.
    // The DM agent loop (agentLoopStreaming) and any deferred subagents
    // (scribe/promote/scene_transition, run in applyDeferredTuiCommands) nest
    // under it via ALS. Errors are caught (not re-thrown) here, so the span is
    // tagged `failed` rather than `isError`.
    await withSpan(
      {
        kind: "turn",
        name: `turn ${this.turnCounter}`,
        campaignId: this.campaignId,
        attrs: { turnNumber: this.turnCounter, participant: characterName },
      },
      async () => {
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

      // `turnMessages` is the bridge's canonical turn: tool_use ↔ tool_result
      // pairs ending in an assistant message whose content is the narration.
      // It always ends on an assistant message (the bridge guarantees this), so
      // decompose into the existing exchange model unconditionally — no shape
      // sniffing. The final assistant message is the DM response; everything
      // before it is the tool interaction context.
      const turn = result.turnMessages;
      const assistantMessage: NormalizedMessage = turn.length > 0
        ? turn[turn.length - 1]
        : { role: "assistant", content: result.text };
      const toolMessages = turn.slice(0, -1);
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
          // Images emitted during the turn (via generate_image's display_image
          // TUI command) are appended after the DM's text so they sit at the
          // visual end of the turn in scrollback. The actual mid-turn render
          // order is preserved by the live broadcast; here we're just making
          // sure the image survives a reload.
          for (const img of this.imagesEmittedThisTurn) {
            logLines.push({ kind: "image", text: img.filename, intent: img.intent });
          }
          logLines.push({ kind: "dm", text: "" }); // paragraph separator
          // Pass campaignRoot so image paths land relative — keeps the
          // display-log portable across machines if the campaign is moved.
          this.persister.appendDisplayLog(narrativeLinesToMarkdown(logLines, this.gameState.campaignRoot));
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

      // Track exchange for git auto-commit. Use the raw player message as the
      // commit subject so the savestate log is browsable; synthetic system
      // turns (skipTranscript: session open/resume) fall back to the generic
      // label.
      await this.repo?.trackExchange(opts?.skipTranscript ? undefined : text);

      // Run scene tracker periodically to maintain open threads / NPC intents
      // TODO(perf): detach this as a deferred-work lane like the scribe. It's
      // write-back — its threads/intents feed the DM's next-turn `activeState`
      // (buildActiveState) — so use a barrier-for-freshness at the next-turn
      // context build: free in the common case (human think-time hides it),
      // only blocks if the player out-races it, never a regression. Runs in
      // parallel with the scribe lane, so think-time hides max(), not sum().
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

      // Process deferred TUI commands — engine-side work (scene transitions,
      // subagent spawns, file I/O) plus any visual commands we explicitly
      // deferred for ordering reasons (currently `present_choices`, so the
      // modal can't beat the DM's prose to the screen). Visual-only
      // commands not in DEFERRED_TUI_TYPES (modeline, resources, theme)
      // were already broadcast to the client immediately when the tool
      // fired.
      await this.applyDeferredTuiCommands(result.tuiCommands);

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "large");

      logEvent("turn:dm_complete", {
        textLength: result.text.length,
        toolCalls: toolCallCount,
        rounds: result.turnMessages.filter((m) => m.role === "assistant").length,
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
      setSpanAttrs({ failed: true });
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
      },
    );

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

    // Detached background span (root). This is fire-and-forget from the turn
    // (void-called after the turn span closes), so it must NOT extend the turn
    // bar — `root: true` starts a fresh trace so the choice-generator subagent
    // shows as its own short bar in the timeline.
    await withSpan(
      { kind: "background", name: "suggested_choices", campaignId: this.campaignId, root: true },
      async () => {
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
      },
    );
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
      provider: this.tierProviders.small.provider,
      model: this.tierProviders.small.model,
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
    // Arm the re-entrancy guard BEFORE the barrier: transitionScene is
    // reachable from `waiting_input` (the server `/scene` command), so flushing
    // while still input-accepting would let a concurrent processInput slip in
    // and touch entity state mid-transition. setState to a non-input state
    // first (as processInput does), THEN flush — a scene transition rebuilds
    // the next scene's opening from persisted entity files + changelogs, so
    // every detached scribe write must land first (non-blocking within a scene,
    // flushed before it advances).
    this.setState("scene_transition");
    await this.awaitPendingScribe();

    // The conversation is cleared on transition (sceneManager.stepPruneContext),
    // so the BP4 message cache is rebuilt anyway — the free moment to refresh the
    // portrait prefix. Invalidate the cached prefix message so the new scene
    // reloads each PC's *current* portrait (picking up any mid-scene revision),
    // and drop any pending portrait injection: the prefix now carries it, so
    // there's nothing left to hand back as a "previous turn."
    this.cachedPortraitMessage = undefined;
    this.pendingPortraitInjections = [];

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
    // Arm the guard before the barrier (endSession is reachable from
    // `waiting_input` too): set the non-input state, THEN flush the detached
    // scribe so we don't snapshot/close the session over a half-written write.
    this.setState("session_ending");
    await this.awaitPendingScribe();

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
    // Barrier: a git rollback rewrites entity files; let any detached scribe
    // finish first so its writes are part of the snapshot being reverted (not
    // racing the checkout).
    await this.awaitPendingScribe();
    this.callbacks.onDevLog?.(`[dev] rollback: rolling back to "${target}"`);
    const result = await performRollback(this.repo, target, this.gameState.campaignRoot, this.fileIO);
    this.callbacks.onTuiCommand?.({ type: "show_rollback_summary", summary: result.summary });
    throw new RollbackCompleteError(result.summary);
  }

  // --- Validation ---

  // --- Worldbuilding Entity I/O ---

  /**
   * Barrier: await the in-flight detached scribe chain before reading or
   * snapshotting durable entity state. Never throws (the chain is
   * `.catch`-guarded and handleScribe swallows its own errors). Usually
   * resolves instantly — by the time the player acts or the DM ends a scene
   * the background scribe has long finished; it only actually blocks when a
   * scribe overruns that gap, which is exactly when waiting is correct.
   * Public so graceful teardown and deterministic tests can settle it (mirrors
   * `awaitPendingPortraitRenders`).
   */
  async awaitPendingScribe(): Promise<void> {
    await this.pendingScribe;
  }

  /** Spawn the scribe subagent to process batched entity updates */
  private async handleScribe(cmd: TuiCommand): Promise<void> {
    const updates = cmd.updates as { visibility: string; content: string }[];
    if (!updates || updates.length === 0) return;

    const subStart = Date.now();
    logEvent("subagent:start", { name: "scribe" });
    try {
      const sceneNumber = this.sceneManager.getScene().sceneNumber;
      const small = this.tierProviders.small;
      // (runScribe prefetches the batch's referenced entities and hands them to
      // the subagent as canonical, so it skips the read_entity round-trips —
      // see buildPrefetchedEntityBlock in scribe.ts.)
      const result = await runScribe(small.provider, {
        updates: updates.map(u => ({
          visibility: u.visibility as "private" | "player-facing",
          content: u.content,
        })),
        campaignRoot: this.gameState.campaignRoot,
        sceneNumber,
        entityTree: this.sceneManager.getEntityTree(),
        homeDir: this.gameState.homeDir,
      }, this.fileIO, small.model);

      // Apply entity tree deltas from Scribe
      if (result.entityDeltas) {
        for (const delta of result.entityDeltas) {
          this.sceneManager.upsertEntity(delta);
        }
      }
      if (result.removedSlugs) {
        for (const slug of result.removedSlugs) {
          this.sceneManager.removeEntity(slug);
        }
      }

      logEvent("subagent:end", { name: "scribe", durationMs: Date.now() - subStart });
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(result.usage, "small");
      this.callbacks.onDevLog?.(`[dev] scribe: ${result.summary}`);

      // Now that the scribe runs detached, a PC sheet it rewrote (HP, inventory,
      // conditions) may land seconds after the turn ended — the client's cached
      // sheet is stale until it refetches. Nudge any open character pane to
      // re-pull. Bare signal (no payload): the bridge's default branch forwards
      // `tui:character_sheet_changed`, the client bumps a sheet epoch and
      // re-fetches the active sheet on demand. Gate on an actual character/player
      // write — the pane only shows character sheets, so a location/item/faction
      // edit shouldn't invalidate its cache.
      const touchedSheet = result.entityDeltas.some(
        (d) => d.type === "character" || d.type === "player",
      );
      if (touchedSheet) {
        this.callbacks.onTuiCommand?.({ type: "character_sheet_changed" });
      }
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

    // Barrier: promote reads + rewrites the character sheet and upserts the
    // entity tree. A detached scribe may be rewriting the same files, so flush
    // it first or the read tears / the writes clobber (last-writer-wins).
    await this.awaitPendingScribe();

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

      const small = this.tierProviders.small;
      const result = await promoteCharacter(small.provider, {
        characterName,
        characterSheet: currentSheet,
        context,
        systemRules: ruleCard !== "No rule card available." ? ruleCard : undefined,
      }, undefined, small.model);

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
   * Dispatch the DM's `generate_image` function tool. Calls the active
   * provider's generateImage method, persists the bytes via the shared
   * image-handler, and emits a display_image TUI command on the same
   * tool result so the client renders the image inline as soon as the
   * tool fires (not at end-of-turn). Returns a textual tool_result the
   * model can riff off in its continuation.
   *
   * Errors (no provider support, content refusal, network) surface as
   * an isError tool_result so the model can apologize, retry, or skip.
   */
  private async dispatchGenerateImage(
    input: Record<string, unknown>,
  ): Promise<import("./tool-registry.js").ToolResult> {
    if (!this.provider.generateImage) {
      return {
        content: "Image generation is not available on the configured provider.",
        is_error: true,
      };
    }
    const promptText = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!promptText) {
      return { content: "generate_image requires a non-empty prompt.", is_error: true };
    }
    // Fallback matches the documented DM default (the tool schema marks
    // `effort` required, but coerce defensively so an omitted/invalid value
    // still lands on the intended "quality" tier rather than the lib default).
    const effort = normalizeImageEffort(input.effort, "quality");
    const aspect = normalizeImageAspect(input.aspect);
    // Default to scene_snapshot: that's the DM's overwhelmingly common case
    // (in-narrative scene rendering) and matches the on-disk naming the
    // image-handler picks (scene-NNN-slug-…). player_request is only the
    // right tag when the player explicitly asked for an illustration, and
    // character_portrait is for character close-ups (rare in gameplay —
    // setup-conversation owns the chargen portrait loop).
    const rawIntent = typeof input.intent === "string" ? input.intent : "";
    const intent: "scene_snapshot" | "player_request" | "character_portrait" =
      rawIntent === "scene_snapshot" || rawIntent === "character_portrait" || rawIntent === "player_request"
        ? rawIntent
        : "scene_snapshot";
    // Optional image-to-image references: the DM names characters whose
    // established portrait this render should match (face/build/outfit). Resolve
    // the names to portrait files now — a missing or typo'd name degrades to a
    // text-only render rather than erroring, and an empty list omits the field
    // so we do a plain text-to-image. Off by default: a portrait reference
    // biases the whole render toward that character, wrong for a scene they're
    // not in, so the DM must opt in per call.
    const referenceNames = Array.isArray(input.reference_characters)
      ? input.reference_characters.filter((n): n is string => typeof n === "string")
      : [];
    const referenceImages = referenceNames.length > 0
      ? await loadCharacterReferences(
          referenceNames,
          this.sceneManager.getFileIO(),
          this.gameState.campaignRoot,
        )
      : [];
    try {
      const result = await this.provider.generateImage({
        prompt: promptText,
        effort,
        aspect,
        intent,
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });
      const scene = this.sceneManager.getScene();
      const persisted = await handleImageGenerated(
        this.sceneManager.getFileIO(),
        this.gameState.campaignRoot,
        { sceneNumber: scene.sceneNumber, slug: scene.slug || "untitled" },
        {
          // Timestamp-based surrogate id — never sent to the API. Lives in
          // the on-disk sidecar JSON so each generation has a stable handle
          // for log correlation. (Earlier hosted-tool path used the
          // response's revised_prompt here; the function-tool path no
          // longer surfaces that, so we synthesize instead.)
          id: `img-${Date.now()}`,
          base64: result.base64,
          mimeType: result.mimeType,
          intent,
          ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
        },
      );
      const absPath = norm(`${this.gameState.campaignRoot}/${persisted.relPath}`);
      return {
        content: `Image rendered and displayed to the player (${result.effortUsed} effort, ${result.aspectUsed} aspect). The model's next narrative can reference it.`,
        // _tui field attaches a TUI command to the tool result so it
        // broadcasts immediately, before the DM's continuation runs.
        _tui: {
          type: "display_image",
          filename: absPath,
          relPath: persisted.relPath,
          intent,
        },
      } as import("./tool-registry.js").ToolResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Engine log: visible to the harness + post-mortem dumps. onDevLog
      // alone goes to the TUI dev pane and disappears with the process.
      logEvent("image_gen:dispatch_failed", {
        agent: "dm",
        message: msg.slice(0, 400),
      });
      this.callbacks.onDevLog?.(`[image] generate failed: ${msg}`);
      return { content: `Image generation failed: ${msg}`, is_error: true };
    }
  }

  /**
   * Silent portrait revision (`update_portrait`). Re-renders a PC's portrait
   * conditioned on their current one to reflect a durable appearance change,
   * archives the prior version, and hands the new portrait back to the DM in
   * context on a later turn. Unlike `generate_image` it does NOT display to the
   * player and does NOT block the turn: it returns an immediate ack (which
   * persists the DM's intent in conversation) and runs the render in the
   * background. The new bytes land on disk + swap the current pointer via the
   * tracked promise's own continuation.
   */
  private async dispatchUpdatePortrait(
    input: Record<string, unknown>,
  ): Promise<import("./tool-registry.js").ToolResult> {
    if (!this.provider.generateImage) {
      return { content: "Image generation is not available on the configured provider.", is_error: true };
    }
    const name = typeof input.character === "string" ? input.character.trim() : "";
    // Cap the change description — it rides into the render prompt, the
    // persisted ack, and the next-turn context marker, so an over-long string
    // bloats all three.
    const change = (typeof input.change === "string" ? input.change.trim() : "").slice(0, MAX_PORTRAIT_CHANGE_CHARS);
    if (!name || !change) {
      return { content: "update_portrait requires both `character` and `change`.", is_error: true };
    }

    const fileIO = this.sceneManager.getFileIO();
    if (!fileIO.writeBinaryFile) {
      // Bail before spending a (paid, minutes-long) render we couldn't persist.
      return { content: "Portrait revision isn't available here (no file persistence).", is_error: true };
    }
    const root = this.gameState.campaignRoot;

    // Condition the revision on the current portrait so identity carries
    // forward — change one thing, keep the rest. No existing portrait → nothing
    // to revise (e.g. an NPC, or a campaign where image-gen was off at setup).
    const referenceImages = await loadCharacterReferences([name], fileIO, root);
    if (referenceImages.length === 0) {
      return {
        content: `No saved portrait for "${name}" to revise — update_portrait only works on a character who already has one.`,
        is_error: true,
      };
    }

    logEvent("portrait_update:requested", { agent: "dm", character: name, change: change.slice(0, 200) });

    const generateImage = this.provider.generateImage.bind(this.provider);
    const render = (async () => {
      try {
        const result = await generateImage({
          prompt: buildPortraitRevisionPrompt(name, change),
          effort: "standard",
          aspect: "portrait",
          intent: "character_portrait",
          referenceImages,
        });
        const bytes = Buffer.from(result.base64, "base64");
        const small = await downscalePortraitForContext(bytes);
        // Serialize archive+swap+stash through the commit chain: renders run in
        // parallel, but this fast critical section must be one-at-a-time so two
        // revisions completing close together don't compute the same archive
        // version and clobber history. The chain swallows errors so one failure
        // can't poison later commits; `commit` re-throws into the catch below.
        const commit = this.portraitCommitChain.then(async () => {
          const { archivedVersion } = await commitPortraitRevision(fileIO, root, name, bytes);
          this.pendingPortraitInjections.push({
            name,
            change,
            image: { type: "image_input", base64: small.base64, mimeType: small.mimeType, lowDetail: true, label: name },
          });
          logEvent("portrait_update:completed", { agent: "dm", character: name, archivedVersion });
        });
        this.portraitCommitChain = commit.catch(() => undefined);
        await commit;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logEvent("portrait_update:failed", { agent: "dm", character: name, message: msg.slice(0, 400) });
        this.callbacks.onDevLog?.(`[portrait] update for ${name} failed: ${msg}`);
      }
    })();
    this.trackPortraitRender(render);

    return {
      content:
        `Portrait revision for ${name} started in the background (silent — the player sees no image). ` +
        `It will reflect: ${change}. The updated portrait returns to you in context on a later turn; ` +
        `narrate the change in the fiction now, and do not announce a new image.`,
    };
  }

  /** Track a background portrait render so failures aren't swallowed and teardown can await it. */
  private trackPortraitRender(p: Promise<void>): void {
    this.inFlightPortraitRenders.add(p);
    void p.finally(() => this.inFlightPortraitRenders.delete(p));
  }

  /**
   * Await any in-flight background `update_portrait` renders. Each settles on
   * its own (disk write + pointer swap happen in the promise), so callers don't
   * normally need this — it exists for graceful teardown and deterministic tests.
   */
  async awaitPendingPortraitRenders(): Promise<void> {
    await Promise.all([...this.inFlightPortraitRenders]);
  }

  /**
   * Drain revised portraits into image_input + label parts for the next user
   * message. Returns [] when nothing is pending (the common case keeps the
   * user message a plain string).
   */
  private consumePendingPortraitInjections(): ContentPart[] {
    if (this.pendingPortraitInjections.length === 0) return [];
    // Strip structural chars + collapse whitespace so a name/change can't break
    // the marker or smuggle markup into the DM context. The values are
    // model-authored (not untrusted user input), but keep the frame well-formed
    // regardless — a stray quote or newline shouldn't malform the tag.
    const safe = (s: string) => s.replace(/[<>"&]/g, " ").replace(/\s+/g, " ").trim();
    const parts: ContentPart[] = [];
    for (const inj of this.pendingPortraitInjections) {
      parts.push({
        type: "text",
        text: `<portrait_updated character="${safe(inj.name)}">Now reflects: ${safe(inj.change)}</portrait_updated>`,
      });
      parts.push(inj.image);
    }
    this.pendingPortraitInjections = [];
    return parts;
  }

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
        const small = this.tierProviders.small;
        const result = await styleTheme(
          small.provider,
          description,
          undefined, // current theme name not easily accessible here
          undefined, // current key color not easily accessible here
          small.model,
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

    this.imageGenInFlight = 0;
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
      // ai-player picks small or medium based on `player.model` ("haiku"/"sonnet").
      // Resolve the matching tier here so the AI player runs through the right
      // connection in heterogeneous setups.
      const aiTierName: ModelTier = active.player.model === "sonnet" ? "medium" : "small";
      const aiTier = this.tierProviders[aiTierName];
      const result = await aiPlayerTurn(aiTier.provider, {
        player: active.player,
        characterSheet,
        recentNarration: recentAssistant || "It's your turn. What do you do?",
      }, aiTier.model);

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
      this.callbacks.onUsageUpdate(result.usage, aiTierName);

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
    // Image gen is gated on BOTH provider capability and campaign
    // preference. Treat any non-"off" preference (including unset and
    // undefined for legacy campaigns) as opt-in for now — phase 8 wires
    // the setup-agent's explicit consent question, after which "unset"
    // shouldn't occur for new campaigns. Existing campaigns get image
    // gen enabled by default when the provider supports it, which
    // matches the spec's "default on when capability is present" intent.
    const capability = this.provider.getCapabilities?.(this.model).imageGeneration ?? false;
    const preference = this.gameState.config.image_generation;
    const imageGenEnabled = capability && preference !== "off";

    return {
      model: this.model,
      provider: this.provider,
      maxTokens: getMaxOutput(this.model),
      maxToolRounds: 10,
      imageGenEnabled,
      asyncToolHandler: (name, input) => this.handleAsyncToolInternal(name, input),
      onTextDelta: (delta) => this.callbacks.onNarrativeDelta(delta),
      onToolStart: (name) => {
        if (name === GENERATE_IMAGE_TOOL_NAME) this.imageGenInFlight++;
        // An in-flight image render owns the indicator (it's the slow, notable
        // one); otherwise it's a generic tool.
        this.setState(this.imageGenInFlight > 0 ? "generating_image" : "tool_running");
        this.callbacks.onToolStart(name);
      },
      onToolEnd: (name, result) => {
        if (name === GENERATE_IMAGE_TOOL_NAME && this.imageGenInFlight > 0) this.imageGenInFlight--;
        // Stay on "generating_image" while any render is still going — a faster
        // sibling tool finishing first must not drop the image indicator.
        this.setState(this.imageGenInFlight > 0 ? "generating_image" : "dm_thinking");
        this.callbacks.onToolEnd(name, result);
      },
      onTuiCommand: (cmd) => {
        // Immediate TUI commands (modeline, resources, choices, etc.)
        // are broadcast to the client as soon as the tool fires, so
        // visual updates appear mid-narration instead of after the turn.
        if (cmd.type === "present_choices") {
          this.dmProvidedChoicesThisTurn = true;
        } else if (cmd.type === "display_image") {
          // Capture for display-log persistence at end-of-turn. The
          // image lands in scrollback at the right ordinal position
          // on session resume — without this, the bytes persist on
          // disk but disappear from the in-game transcript after a
          // reload. TuiCommand is a loose `{ type, [k]: unknown }`
          // shape, so we narrow at the use site.
          const filename = typeof cmd.filename === "string" ? cmd.filename : "";
          const rawIntent = typeof cmd.intent === "string" ? cmd.intent : "";
          const intent: "scene_snapshot" | "player_request" | "character_portrait" =
            rawIntent === "scene_snapshot" || rawIntent === "player_request" || rawIntent === "character_portrait"
              ? rawIntent
              : "scene_snapshot";
          if (filename) {
            this.imagesEmittedThisTurn.push({ filename, intent });
          }
        }
        this.callbacks.onTuiCommand(cmd);
      },
      onRetry: (status, delayMs) => this.callbacks.onRetry(status, delayMs),
      onRollback: () => this.callbacks.onRollback?.(),
    };
  }

  /**
   * Lazily build the entity-tool dispatcher. Stable across turns so the
   * underlying store's scan/drift caches survive between calls.
   */
  private getEntityToolDispatcher(): (name: string, input: Record<string, unknown>) => Promise<import("./tool-registry.js").ToolResult | null> {
    if (!this.entityToolDispatcher) {
      this.entityStore = new EntityStore(this.gameState.campaignRoot, this.fileIO);
      this.entityToolDispatcher = buildEntityToolHandler(this.entityStore, {
        sceneNumber: this.sceneManager.getScene().sceneNumber,
      });
    }
    return this.entityToolDispatcher;
  }

  /** Public accessor — used by OOC/Dev wiring that needs the live store. */
  getEntityStore(): EntityStore {
    this.getEntityToolDispatcher();
    return this.entityStore as EntityStore;
  }

  /** Handle tools that require async work (subagent spawning, I/O). */
  private async handleAsyncToolInternal(
    name: string,
    input: Record<string, unknown>,
  ): Promise<import("./tool-registry.js").ToolResult | null> {
    // Entity tools — encapsulated dispatcher, owns the store, cache lives
    // for the GameEngine's lifetime.
    if (ENTITY_TOOL_NAME_SET.has(name)) {
      return this.getEntityToolDispatcher()(name, input);
    }

    if (name === "generate_image") {
      return this.dispatchGenerateImage(input);
    }

    if (name === UPDATE_PORTRAIT_TOOL_NAME) {
      return this.dispatchUpdatePortrait(input);
    }

    /**
     * Inlined to keep the dispatch table flat. Mirrors setup-conversation's
     * dispatchGenerateImage but with DM-side context: scene number/slug for
     * the on-disk basename, scene_snapshot intent default (DM usually
     * generates scenes, not portraits).
     */
    // (see private dispatchGenerateImage method below)

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
        const small = this.tierProviders.small;
        const result = await searchCampaign(small.provider, {
          query,
          campaignRoot: this.gameState.campaignRoot,
        }, this.fileIO, small.model);

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
        const small = this.tierProviders.small;
        const result = await searchContent(small.provider, {
          query,
          systemSlug,
          homeDir: this.gameState.homeDir,
        }, this.fileIO, small.model);

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

      const medium = this.tierProviders.medium;
      this.resolveSession = new ResolveSession(medium.provider, this.fileIO, this.gameState, medium.model, this.tierProviders.small);
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


