/**
 * Session manager — holds one active game session per process.
 *
 * Manages WebSocket connections (players + spectators), orchestrates
 * the GameEngine lifecycle, and routes messages between engine and clients.
 */
import { join, dirname } from "node:path";
import { readFileSync, createWriteStream, type WriteStream } from "node:fs";
import type { WebSocket } from "ws";
import { logEvent } from "../context/engine-log.js";
import type {
  ServerEvent,
  ConnectionIdentity,
  StateSnapshot,
  CampaignConfig,
  GameState,
  UsageStatus,
} from "@machine-violet/shared";
import { GameEngine } from "../agents/game-engine.js";
import { RollbackCompleteError } from "@machine-violet/shared/types/errors.js";
import type { SceneState } from "../agents/scene-manager.js";
import { detectSceneState, loadContentBoundaries } from "../agents/scene-manager.js";
import { buildUIState, type DMSessionState } from "../agents/dm-prompt.js";
import { buildNameInspiration } from "../agents/name-inspiration.js";
import { getActivePlayer } from "../agents/player-manager.js";
import { loadEnv } from "../config/first-launch.js";
import { loadConnectionStore, buildEffectiveConnections } from "../config/connections.js";
import { buildTierProvidersWithCache } from "../config/tier-resolver.js";
import type { LLMProvider } from "../providers/types.js";
import { configDir, norm } from "../utils/paths.js";
import { processingPaths } from "../config/processing-paths.js";
import { readBundledRuleCard } from "../config/systems.js";
import { sandboxFileIO } from "../tools/filesystem/sandbox.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";
import { buildEntityTree, renderEntityTree } from "../tools/filesystem/entity-tree.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { createGitIO } from "../tools/git/isogit-adapter.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { markdownToNarrativeLines } from "../context/display-log.js";
import { CostTracker } from "../context/cost-tracker.js";
import { TurnManager } from "./turn-manager.js";
import type { StyleVariant } from "@machine-violet/shared/types/tui.js";
import { createBridge } from "./bridge.js";
import { createBaseFileIO } from "./fileio.js";
import { SetupSession } from "./setup-session.js";
import { generateDiscordStatus } from "../agents/subagents/discord-status.js";
import { classifyServerError, userMessageFor, performSessionFatalTeardown } from "./error-classify.js";

/** DM-narrative interval at which a fresh Discord presence string is generated. */
const DISCORD_STATUS_INTERVAL = 8;

export interface ConnectedClient {
  ws: WebSocket;
  identity: ConnectionIdentity;
  /** Last-reported viewport dims, or undefined if never reported. */
  dims?: { columns: number; rows: number; narrativeRows: number };
}

/**
 * Compute the viewport floor — the most-constrained dims across all
 * clients that have reported. Returns undefined if no client has
 * reported. Exported for unit testing.
 *
 * Primary sort: smallest `narrativeRows` (drives the length hint).
 * Tiebreak: smallest `columns`, then smallest `rows`. Without the
 * tiebreak two clients sharing terminal height but with different
 * widths would yield insertion-order-dependent columns, which mis-sizes
 * GameEngine's wrappedLineCount calculation (it uses
 * `terminalDims.columns - 4` as the wrap width).
 */
export function computeViewportFloor(
  clients: Iterable<Pick<ConnectedClient, "dims">>,
): { columns: number; rows: number; narrativeRows: number } | undefined {
  let floor: { columns: number; rows: number; narrativeRows: number } | undefined;
  for (const entry of clients) {
    if (!entry.dims) continue;
    if (!floor) {
      floor = entry.dims;
      continue;
    }
    if (entry.dims.narrativeRows < floor.narrativeRows) {
      floor = entry.dims;
    } else if (entry.dims.narrativeRows === floor.narrativeRows) {
      if (entry.dims.columns < floor.columns) {
        floor = entry.dims;
      } else if (entry.dims.columns === floor.columns && entry.dims.rows < floor.rows) {
        floor = entry.dims;
      }
    }
  }
  return floor;
}

export type SessionStatus = "idle" | "starting" | "active" | "stopping";

/**
 * Reasons a session can end. Drives teardown behavior — "rollback" skips
 * the flush+checkpoint that would otherwise clobber rolled-back disk state
 * with stale in-memory values. Keep this a closed union so new callsites
 * can't silently bypass the rollback-safe path with a typo'd string.
 *
 * `session_fatal` is the mid-game "auth expired / wrong model / classifier
 * refusal" path (issue #529). It behaves like `explicit` for persistence —
 * flush + checkpoint so the player resumes with no lost turns — but the
 * caller is expected to broadcast a `session-fatal-recoverable` error
 * event around the teardown so the client drops to the main menu with the
 * cause in a red banner.
 */
export type EndSessionReason = "explicit" | "idle_timeout" | "rollback" | "session_fatal";

export class SessionManager {
  private campaignsDir: string;
  private clients = new Map<WebSocket, ConnectedClient>();
  private turnManager: TurnManager | null = null;
  private status: SessionStatus = "idle";
  /** Incremented on each session start; stale callbacks check this to avoid leaking events. */
  private sessionGeneration = 0;
  private engine: GameEngine | null = null;
  private gameState: GameState | null = null;
  private costTracker: CostTracker | null = null;
  /** Providers held for this session — disposed on endSession. Stateful providers
   *  like openai-chatgpt own subprocesses that must be torn down between sessions. */
  private sessionProviders = new Set<LLMProvider>();
  /** connectionId → provider lookup, populated alongside sessionProviders.
   *  Used by management routes (e.g. usage queries) that need to find a
   *  live provider instance for a specific connection. */
  private providersByConnectionId = new Map<string, LLMProvider>();
  /** Unsubscribe callbacks for active provider usage subscriptions.
   *  Drained at endSession so the listeners don't leak across sessions. */
  private usageUnsubscribers: (() => void)[] = [];
  /** Latest UsageStatus broadcast for the DM tier, replayed to newly
   *  connecting clients so the gauge / Esc menu show data immediately
   *  instead of waiting for the next codex response. */
  private lastUsageStatus: UsageStatus | null = null;
  private currentMode: "play" | "ooc" | "dev" | "setup" = "play";
  private persistedUI: { themeName?: string; variant?: string; keyColor?: string | null; modelines?: Record<string, string> | null } = {};
  /** One-shot recap payload: set during sessionResume, emitted in the next
   *  buildStateSnapshot() call and cleared. Ensures only the first snapshot
   *  after a clean session-end carries the recap. */
  private pendingSessionRecap: { id: string; lines: string[] } | null = null;
  /**
   * Authoritative committed transcript for the active session.
   *
   * Tracks only `dm` and `player` lines — the kinds the state:snapshot
   * narrativeLines schema accepts. (The persisted display log additionally
   * keeps `system` and `separator` lines, but those are presentation-only
   * and not mirrored into the live committed log.) Stored as one entry per
   * text line — multi-paragraph DM/player text is split on `\n` at append
   * time so the shape matches what `appendDelta` produces during live
   * streaming and what `markdownToNarrativeLines` produces from the on-disk
   * log on resume; the client can therefore replace its narrative log with
   * this verbatim and have it render identically.
   *
   * Replayed into a state:snapshot when the client needs an authoritative
   * reset — on connect (so reconnects see history) or on retry rollback
   * (so a partial DM stream that's about to be re-issued doesn't
   * accumulate twice in the client log). Seeded from the display log on
   * resume; appended to as DM responses complete and as `client`-source
   * contributions arrive. Reset on each new session start.
   */
  private committedNarrative: { kind: "dm" | "player"; text: string }[] = [];
  private setupSession: SetupSession | null = null;

  /** Campaign ID of the currently active session (null if none). */
  private campaignId: string | null = null;

  /** Timer that fires when no players have been connected for IDLE_TIMEOUT_MS. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Optional write stream for WS event logs (--ws-log). */
  private wsLogStream: WriteStream | null = null;

  constructor(campaignsDir: string) {
    this.campaignsDir = campaignsDir;
  }

  /** Enable WebSocket event logging to a file. */
  setWsLog(filePath: string): void {
    this.wsLogStream = createWriteStream(filePath, { flags: "a" });
  }

  // --- Connection management ---

  addClient(ws: WebSocket, identity: ConnectionIdentity): void {
    this.clients.set(ws, { ws, identity });

    // A player connected — cancel any pending idle timeout
    if (identity.role === "player") {
      this.clearIdleTimer();
    }

    ws.on("close", () => {
      this.clients.delete(ws);
      this.recomputeViewportFloor();
      this.checkIdleTimeout();
    });

    // Send current state snapshot on connect. Include the committed
    // narrative so reconnecting clients see history without needing the
    // server to re-stream it; first-time connections during an active
    // session pick up everything that was committed before they joined.
    if (this.status === "active") {
      const snapshot = this.buildStateSnapshot({ includeNarrative: true });
      this.sendTo(ws, {
        type: "state:snapshot",
        data: snapshot,
      });
      // Replay the latest provider usage so the bottom-right gauge / Esc
      // menu percentage render immediately instead of waiting for the
      // next codex response.
      if (this.lastUsageStatus) {
        this.sendTo(ws, { type: "usage:update", data: this.lastUsageStatus });
      }
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.recomputeViewportFloor();
    this.checkIdleTimeout();
  }

  /**
   * Update a connected client's reported viewport dims and push the new
   * floor (min `narrativeRows` across all clients) to the engine.
   *
   * Called from the WS handler when a `client:viewport` message arrives.
   * If the floor rises because the previously-smallest client either
   * disconnected or reported larger dims, the DM sees the new (larger)
   * floor on its next turn.
   */
  updateClientViewport(
    ws: WebSocket,
    dims: { columns: number; rows: number; narrativeRows: number },
  ): void {
    const entry = this.clients.get(ws);
    if (!entry) return;
    entry.dims = dims;
    this.recomputeViewportFloor();
  }

  /** Recompute the floor across all connected clients and push to engine. */
  private recomputeViewportFloor(): void {
    if (!this.engine) return;
    const floor = computeViewportFloor(this.clients.values());
    if (floor) {
      this.engine.setTerminalDims(floor);
    }
  }

  // --- Broadcasting ---

  broadcast(event: ServerEvent): void {
    // Track mode changes for state snapshots
    if (event.type === "session:mode") {
      const mode = (event.data as { mode?: string }).mode;
      if (mode === "play" || mode === "ooc" || mode === "dev" || mode === "setup") {
        this.currentMode = mode;
      }
    }
    const msg = JSON.stringify(event);

    // WS event log (--ws-log)
    if (this.wsLogStream) {
      try {
        // Truncate narrative:chunk text to keep log readable
        let logLine: string;
        if (event.type === "narrative:chunk") {
          const d = event.data as { text?: string; kind?: string };
          const text = d.text ?? "";
          logLine = JSON.stringify({
            t: Date.now(), type: event.type,
            kind: d.kind, len: text.length,
            preview: text.slice(0, 120) + (text.length > 120 ? "…" : ""),
          });
        } else {
          logLine = JSON.stringify({ t: Date.now(), ...event });
        }
        this.wsLogStream.write(logLine + "\n");
      } catch { /* don't break broadcast on log failure */ }
    }

    for (const { ws } of this.clients.values()) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(msg);
      }
    }
  }

  sendTo(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(event));
    }
  }

  broadcastToPlayers(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const { ws, identity } of this.clients.values()) {
      if (identity.role === "player" && ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(msg);
      }
    }
  }

  // --- Accessors ---

  getCampaignsDir(): string {
    return this.campaignsDir;
  }

  getEngine(): GameEngine | null {
    return this.engine;
  }

  getGameState(): GameState | null {
    return this.gameState;
  }

  getCostTracker(): CostTracker | null {
    return this.costTracker;
  }

  /**
   * Look up the live provider instance for a given connection id, or null
   * if no session is active or the connection isn't backing an assigned
   * tier. Used by management routes that need to query a stateful
   * provider (e.g. openai-chatgpt usage status).
   */
  getProviderForConnectionId(connectionId: string): LLMProvider | null {
    return this.providersByConnectionId.get(connectionId) ?? null;
  }

  // --- Setup session ---

  /** Start a campaign creation session with a real temp GameState. */
  async startSetup(): Promise<void> {
    if (this.status !== "idle") throw new Error("A session is already active.");
    this.status = "starting";
    try {
      await this.doStartSetup();
    } catch (err) {
      this.status = "idle";
      throw err;
    }
  }

  private async doStartSetup(): Promise<void> {
    const homeDir = this.campaignsDir.replace(/[/\\]campaigns\/?$/, "");

    // Create a temp campaign directory for setup state.
    // Clean up any previous setup state first (inspectable between runs).
    const setupRoot = join(this.campaignsDir, "__setup__");
    const { mkdir, rm } = await import("node:fs/promises");
    await rm(setupRoot, { recursive: true, force: true });
    await mkdir(join(setupRoot, "state"), { recursive: true });

    // Build a minimal GameState so turns, context dumps, etc. work
    const setupConfig: CampaignConfig = {
      name: "Setup",
      dm_personality: { name: "Setup MC", prompt_fragment: "" },
      players: [{ name: "Player", character: "Player", type: "human", color: "#ffffff" }],
      combat: { initiative_method: "fiction_first", round_structure: "individual", surprise_rules: false },
      context: { retention_exchanges: 0, max_conversation_tokens: 0 },
      recovery: { auto_commit_interval: 0, max_commits: 0, enable_git: false },
      choices: { campaign_default: "never", player_overrides: {} },
    };

    this.gameState = {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: setupConfig.combat,
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config: setupConfig,
      campaignRoot: setupRoot,
      homeDir,
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
    };

    this.sessionGeneration++;
    const gen = this.sessionGeneration;
    this.setupSession = new SetupSession(
      this.campaignsDir, homeDir, (event) => {
        if (this.sessionGeneration !== gen) return;
        this.broadcast(event);
      },
    );
    this.status = "active";
    this.currentMode = "setup";
    this.campaignId = "__setup__";

    // Start idle timer in case no players are connected yet
    this.checkIdleTimeout();

    // Debug: context dumps in the temp setup dir
    const { setContextDumpDir } = await import("../config/context-dump.js");
    setContextDumpDir(join(setupRoot, ".debug", "context"));

    // Initialize turn manager for setup input
    const setupBroadcast = (event: ServerEvent) => {
      if (this.sessionGeneration !== gen) return;
      this.broadcast(event);
    };
    this.turnManager = new TurnManager(setupBroadcast, "__setup__");
    this.turnManager.setCommitHandler(async (contributions) => {
      if (!this.setupSession) return;
      const text = contributions.map((c) => c.text).join("\n");
      // Choice-modal selections (fromChoice=true) resolve a pending
      // present_choices tool_use as a selection. Free-form text — even when
      // a choice is pending — is treated as a dismissal so the agent's
      // tool_result reflects the player's actual intent.
      const isChoiceSelection = contributions.some((c) => c.fromChoice)
        && this.setupSession.hasPendingChoice;
      const result = isChoiceSelection
        ? await this.setupSession.resolveChoice(text)
        : await this.setupSession.send(text);
      if (result.finalized) {
        await this.transitionToGame(result.finalized, result.campaignName);
      } else {
        this.openNextTurn();
      }
    });

    // Start the setup conversation in the background
    const setup = this.setupSession;
    void setup.start().then(() => {
      if (this.setupSession === setup) this.openNextTurn();
    }).catch((err) => {
      // Only handle errors for the current setup session / generation
      if (this.setupSession !== setup || this.sessionGeneration !== gen) return;

      logEvent("session:error", {
        phase: "setup",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      // Tear down setup state so a new setup can be started. Setup has no
      // per-campaign persistence (the temp __setup__ dir is recreated on
      // every retry), so we skip the flush/checkpoint dance that the
      // mid-game session_fatal path needs. We do still need to dispose
      // the tier providers — without that an openai-chatgpt setup that
      // errored leaves its codex subprocess running, and repeated
      // setups accumulate processes.
      const oldSetup = this.setupSession;
      this.setupSession = null;
      this.turnManager = null;
      this.status = "idle";
      void oldSetup?.dispose();

      // Session-fatal: setup has died for a reason the player must address
      // (auth, model, classifier refusal). Surfacing as `recoverable: false`
      // with the new category drops the client to the main menu with the
      // verbatim message in a red banner.
      //
      // Setup has no per-campaign persistence and no retry path of its
      // own (we already tore down setupSession above), so pass
      // "session-fatal-recoverable" as the explicit default — overriding
      // classifyServerError's "retryable" fallback. Without this, an
      // unknown error class would silently route to a retry UX that
      // can't actually retry.
      this.broadcast({
        type: "error",
        data: {
          message: userMessageFor(err),
          recoverable: false,
          category: classifyServerError(err, "session-fatal-recoverable"),
        },
      });
    });
  }

  getSetupSession(): SetupSession | null {
    return this.setupSession;
  }

  /** Transition from setup to a real game session. */
  private async transitionToGame(campaignId: string, campaignName?: string): Promise<void> {
    // Tell clients to reconnect — the campaign ID is about to change.
    // Clients that handle session:transition will disconnect, then
    // reconnect after the new session is ready.
    this.broadcast({ type: "session:transition", data: { campaignId, campaignName: campaignName ?? campaignId } });

    // Dispose the setup-session's tier providers before nulling the
    // reference — otherwise an openai-chatgpt setup tier leaves its
    // codex subprocess running for the rest of the process lifetime.
    const oldSetup = this.setupSession;
    this.setupSession = null;
    this.turnManager = null;
    this.engine = null;
    this.gameState = null;
    void oldSetup?.dispose();
    this.clearIdleTimer();
    this.status = "idle";
    this.campaignId = null;
    this.currentMode = "play";

    logEvent("session:end", { reason: "setup_transition", campaignId });

    // Start the newly created campaign
    await this.startSession(campaignId);
  }

  /** True when the session is fully running and safe to route gameplay requests to. */
  get isActive(): boolean {
    return this.status === "active";
  }

  /** True when any session operation is in progress (blocks new starts). */
  get isBusy(): boolean {
    return this.status !== "idle";
  }

  get sessionStatus(): SessionStatus {
    return this.status;
  }

  get currentCampaignId(): string | null {
    return this.campaignId;
  }

  /** Start a game session for the given campaign. */
  async startSession(campaignId: string): Promise<void> {
    if (this.status !== "idle") {
      throw new Error("A session is already active. End it before starting a new one.");
    }
    this.status = "starting";

    try {
      await this.doStartSession(campaignId);
    } catch (err) {
      // Reset to idle so subsequent starts aren't blocked
      this.status = "idle";
      throw err;
    }
  }

  private async doStartSession(campaignId: string): Promise<void> {
    // --- Load campaign config ---
    const campaignRoot = join(this.campaignsDir, campaignId);
    const configPath = join(campaignRoot, "config.json");
    let config: CampaignConfig;
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as CampaignConfig;
    } catch (err) {
      throw new Error(`Failed to load campaign config: ${err instanceof Error ? err.message : err}`, { cause: err });
    }

    // --- Ensure API key is loaded ---
    loadEnv();

    // --- Resolve per-tier providers from connections ---
    // Each tier (large/medium/small) becomes a {provider, model} pair. The DM
    // runs on `large`; subagents pick `medium` or `small` per task. Resolving
    // all three up front means a heterogeneous setup (e.g. Large=OpenAI,
    // Medium/Small=Anthropic) routes each call to the right vendor without
    // ever sending an Anthropic model ID through an OpenAI client.
    const appConfigDir = configDir();
    const connStore = buildEffectiveConnections(loadConnectionStore(appConfigDir), appConfigDir);
    const { createAnthropicProvider } = await import("../providers/anthropic.js");
    const tierResolution = buildTierProvidersWithCache(connStore, () => createAnthropicProvider(), appConfigDir);
    const tierProviders = tierResolution.tiers;

    // Track unique providers for end-of-session disposal. Stateful providers
    // (openai-chatgpt) own subprocesses that linger across sessions otherwise.
    this.sessionProviders.add(tierProviders.large.provider);
    this.sessionProviders.add(tierProviders.medium.provider);
    this.sessionProviders.add(tierProviders.small.provider);

    // Build the connectionId → provider lookup for management routes.
    this.providersByConnectionId.clear();
    for (const [connId, provider] of tierResolution.byConnectionId) {
      this.providersByConnectionId.set(connId, provider);
    }

    // The DM uses the large tier; keep `provider` as a local alias for the
    // many downstream sites in this method that still reference it directly.
    const provider = tierProviders.large.provider;

    // Wire usage broadcasts for the DM-tier provider. Currently only
    // openai-chatgpt exposes a usage concept; other providers omit
    // `subscribeUsage` and this block is a no-op for them. Seeded with the
    // current snapshot (if any) so clients connecting before the first
    // codex response still get something to render.
    this.lastUsageStatus = null;
    this.usageUnsubscribers = [];
    if (provider.subscribeUsage) {
      const seed = provider.getUsageStatus?.() ?? null;
      if (seed) {
        this.lastUsageStatus = seed;
        this.broadcast({ type: "usage:update", data: seed });
      }
      const unsub = provider.subscribeUsage((status) => {
        this.lastUsageStatus = status;
        this.broadcast({ type: "usage:update", data: status });
      });
      this.usageUnsubscribers.push(unsub);
    }

    // --- Debug: set context dump directory ---
    const { setContextDumpDir } = await import("../config/context-dump.js");
    setContextDumpDir(join(campaignRoot, ".debug", "context"));

    // --- Create and sandbox FileIO ---
    const baseIO = createBaseFileIO();
    const campaignsDir = dirname(campaignRoot);
    const homeDir = dirname(this.campaignsDir);
    const fileIO = sandboxFileIO(baseIO, [campaignRoot, campaignsDir, homeDir]);

    // --- Create GitIO (if enabled) ---
    const gitIO = config.recovery.enable_git ? createGitIO() : undefined;

    // --- Build GameState ---
    const gs: GameState = {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: config.combat,
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config,
      campaignRoot,
      homeDir: this.campaignsDir.replace(/[/\\]campaigns\/?$/, ""),
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
    };

    // --- Detect SceneState (resume existing campaign) ---
    let scene: SceneState;
    let isResume = false;
    try {
      scene = await detectSceneState(campaignRoot, fileIO);
      isResume = scene.transcript.length > 0;
    } catch {
      // New or empty campaign
      scene = {
        sceneNumber: 1,
        slug: "opening",
        transcript: [],
        precis: "",
        openThreads: "",
        npcIntents: "",
        playerReads: [],
        sessionNumber: 1,
        sessionRecapPending: false,
      };
    }

    // --- Load DM session state ---
    const sessionState: DMSessionState = {};
    try {
      const dmNotesPath = campaignPaths(campaignRoot).dmNotes;
      if (await fileIO.exists(dmNotesPath)) {
        sessionState.dmNotes = await fileIO.readFile(dmNotesPath);
      }
    } catch { /* ignore — may not exist yet */ }

    // Load the system's rule card so the DM sees core mechanics (dice notation,
    // resolution rules, advancement, etc.) in its prefix. Prefer the processed
    // copy under ~/.machine-violet/systems/<slug>/rule-card.md (which a user
    // may have customized via ingest); fall back to the bundled copy shipped
    // with the engine. Bundled cards are CC-licensed system summaries.
    if (config.system) {
      try {
        // Use gs.homeDir (the canonical GameState root that loadRuleCardCombat
        // also points at) rather than the locally-derived homeDir, which diverge
        // when campaignsDir doesn't literally end in "campaigns".
        const sysPaths = processingPaths(gs.homeDir, config.system);
        sessionState.rulesAppendix = await fileIO.readFile(norm(sysPaths.ruleCard));
      } catch {
        const bundled = readBundledRuleCard(config.system);
        if (bundled) sessionState.rulesAppendix = bundled;
      }
    }

    // Load PC sheets verbatim so the DM can reference Approaches, Aspects,
    // HP, Inventory, etc. without round-tripping search_campaign for every
    // check. Loaded once at session start and intentionally never refreshed
    // in-session — when the DM edits a sheet via scribe/promote_character it
    // sees the change in conversation, so a stale cached block doesn't
    // matter until the next session reload.
    try {
      const charPaths = campaignPaths(campaignRoot);
      const sheets: string[] = [];
      for (const player of config.players) {
        const filePath = charPaths.character(player.character);
        if (await fileIO.exists(filePath)) {
          sheets.push(await fileIO.readFile(filePath));
        }
      }
      if (sheets.length > 0) {
        sessionState.pcSheets = sheets.join("\n\n---\n\n");
      }
    } catch { /* non-critical — DM can still fall back to search_campaign */ }

    // Sample a fresh multicultural name pool to perturb the DM's naming
    // priors. Drawn once per session and held in DMSessionState so it
    // rides Tier 2 cache instead of churning per turn.
    sessionState.nameInspiration = buildNameInspiration();

    // --- Build entity tree from disk ---
    const entityTree = await buildEntityTree(campaignRoot, fileIO);

    // --- Load content boundaries from machine-scope player files ---
    // Use gs.homeDir (the canonical GameState root) so we agree with the
    // SceneManager refresh path, which reads `state.homeDir`. The locally-
    // derived `homeDir` diverges from `gs.homeDir` in non-standard layouts
    // (e.g. test campaigns dirs that don't literally end in "campaigns").
    try {
      sessionState.contentBoundaries = await loadContentBoundaries(
        config.players,
        gs.homeDir,
        fileIO,
      );
    } catch { /* ignore — players dir may not exist yet */ }

    // --- Cost tracker ---
    this.costTracker = new CostTracker();

    // --- Create bridge (EngineCallbacks → WebSocket events) ---
    // Capture the current session generation so in-flight callbacks from a
    // previous session (e.g. a DM call still streaming after endSession)
    // silently discard their events instead of leaking into the new session.
    this.sessionGeneration++;
    const gen = this.sessionGeneration;
    // Reset the committed transcript for the new session. Resume seeds it
    // from the display log later in resumeSession().
    this.committedNarrative = [];
    const scopedBroadcast = (event: ServerEvent) => {
      if (this.sessionGeneration !== gen) return;
      // Mirror client-side narrative accumulation into the committed log
      // so a snapshot can replay it verbatim. We watch turn:updated for
      // player contributions; DM lines are appended via onNarrativeComplete
      // below. Only client-source contributions are mirrored — engine-source
      // (AI player) contributions follow a separate path.
      if (event.type === "turn:updated") {
        const data = event.data as { contribution?: { source?: string; playerId?: string; text?: string } };
        const c = data.contribution;
        if (c?.source === "client" && c.playerId && typeof c.text === "string") {
          this.appendCommittedLines("player", `[${c.playerId}] ${c.text}`);
        }
      }
      this.broadcast(event);
    };
    // Discord rich-presence: counter resets per backend session load. Every
    // DISCORD_STATUS_INTERVAL DM narratives, the engine asks a small model to
    // summarise the latest narrative as a punchy ≤40-char status string and
    // broadcasts it. Each frontend independently decides whether to forward
    // the result to its local Discord IPC based on its own opt-in setting.
    let dmNarrativeCount = 0;
    const onDmNarrative = (text: string): void => {
      if (this.sessionGeneration !== gen) return;
      dmNarrativeCount++;
      if (dmNarrativeCount % DISCORD_STATUS_INTERVAL !== 0) return;
      void (async () => {
        try {
          // Discord status is a small-tier subagent — route through the small
          // tier's connection so heterogeneous setups send the right model ID.
          const small = tierProviders.small;
          const { status, usage } = await generateDiscordStatus(small.provider, text, small.model);
          if (this.sessionGeneration !== gen) return;
          if (usage) this.costTracker?.record(usage, "small");
          scopedBroadcast({
            type: "discord:presence",
            data: { action: "update", details: status },
          });
        } catch (err) {
          logEvent("discord:status_error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    };

    const callbacks = createBridge({
      broadcast: scopedBroadcast,
      costTracker: this.costTracker,
      onDmNarrative,
      // Fires after the bridge has dropped its pending delta buffer, when
      // a streaming retry is about to re-issue the request. We publish a
      // corrective snapshot so the client replaces its accumulated
      // narrative (which includes the leaked partial output) with the
      // last committed transcript before the retry's deltas arrive.
      onRollback: () => {
        if (this.sessionGeneration !== gen) return;
        scopedBroadcast({
          type: "state:snapshot",
          data: this.buildStateSnapshot({ includeNarrative: true }),
        });
      },
    });

    // Intercept TUI commands so persistedUI stays in sync — ensures
    // buildStateSnapshot() returns accurate theme/modeline data at any time.
    // Apply the same generation guard used by scopedBroadcast so late
    // callbacks from a previous session cannot mutate persistedUI.
    const originalOnTui = callbacks.onTuiCommand;
    callbacks.onTuiCommand = (cmd) => {
      if (this.sessionGeneration !== gen) return;
      this.trackTuiState(cmd);
      originalOnTui(cmd);
    };

    // Mirror DM narrative completions into the committed transcript.
    // Wrapped (not folded into onDmNarrative) because onDmNarrative is
    // sampled — only fires every Nth narrative for Discord status updates,
    // whereas the committed log needs every one.
    const originalOnNarrativeComplete = callbacks.onNarrativeComplete;
    callbacks.onNarrativeComplete = (text, playerAction) => {
      if (this.sessionGeneration === gen && text) {
        this.appendCommittedLines("dm", text);
      }
      originalOnNarrativeComplete(text, playerAction);
    };

    // --- Instantiate GameEngine ---
    // Pass the full tier resolution so the DM (large) and subagents
    // (medium/small) each route to the right vendor.
    const engine = new GameEngine({
      provider,
      tierProviders,
      gameState: gs,
      scene,
      sessionState,
      fileIO,
      callbacks,
      gitIO,
      entityTree,
    });

    this.engine = engine;
    this.gameState = gs;
    this.campaignId = campaignId;
    this.status = "active";

    // Seed the engine with the current viewport floor, if any client has
    // already reported dims (typically during setup which precedes
    // transitionToGame). If none have, LengthSteeringInjection will fall
    // back to its baked default and log a warning on the first turn.
    this.recomputeViewportFloor();

    // Persist cumulative token usage to disk on every API call. The persister
    // queues writes asynchronously, so the per-call overhead is just a JSON
    // stringify + enqueue. Without this, the breakdown only lives in memory
    // and every campaign resume seeds from zero — the resume code in
    // resumeSession() already calls costTracker.seed(loaded.usage), but
    // loaded.usage is always undefined because the file was never written.
    const usagePersister = engine.getPersister();
    const tracker = this.costTracker;
    if (usagePersister && tracker) {
      tracker.onRecord = () => {
        usagePersister.persistUsage(tracker.getBreakdown());
      };
    }

    logEvent("session:start", {
      campaignId,
      isResume,
      provider: provider.providerId,
      scene: scene.sceneNumber,
    });

    // Announce session-level Discord presence info (campaign + DM persona).
    // Frontends with Discord opt-in toggled on use this to call DiscordPresence.start().
    scopedBroadcast({
      type: "discord:presence",
      data: {
        action: "start",
        campaignName: config.name ?? campaignId,
        dmPersona: config.dm_personality?.name ?? "The DM",
      },
    });

    // Start idle timer in case no players are connected yet
    this.checkIdleTimeout();

    // --- Initialize turn manager ---
    this.turnManager = new TurnManager(scopedBroadcast, campaignId);
    this.turnManager.setCommitHandler(async (contributions) => {
      if (!this.engine || !this.gameState) return;
      const text = contributions.map((c) => c.text).join("\n");

      // If a mode session (OOC/Dev) is active, route to it
      const modeSession = this.engine.getModeSession();
      if (modeSession) {
        let modeResult: Awaited<ReturnType<typeof modeSession.send>> | undefined;
        try {
          modeResult = await modeSession.send(text, (delta) => {
            scopedBroadcast({ type: "narrative:chunk", data: { text: delta, kind: "dm" } });
          });
        } catch (err) {
          // OOC/Dev rollback throws RollbackCompleteError to signal that
          // teardown should NOT re-persist in-memory state (would undo the
          // rollback). End the session with the "rollback" reason so
          // endSession skips its flush+checkpoint.
          if (err instanceof RollbackCompleteError) {
            scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
            scopedBroadcast({
              type: "narrative:chunk",
              data: { text: `[${err.message}]`, kind: "system" },
            });
            await this.endSession("rollback");
            return;
          }
          // Session-fatal in OOC/Dev: same flush + teardown + banner path
          // as the normal-play branch below. Mode session errors otherwise
          // bubble to the setImmediate catch in TurnManager and mis-render
          // as recoverable retries.
          if (this.isSessionFatal(err)) {
            await this.handleSessionFatal(err, scopedBroadcast);
            return;
          }
          throw err;
        }
        scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
        this.persistTurnState();

        // If OOC signaled end-of-session, exit OOC and stash the summary
        // so the next DM turn picks up <ooc_summary> context. If OOC also
        // produced a player action, run it through the DM right now so the
        // same turn that exits OOC carries both the summary and the
        // in-character action forward.
        if (modeResult?.endSession) {
          this.engine.setModeSession(null);
          const previousVariant = this.engine.getPreviousVariant() ?? "exploration";
          scopedBroadcast({
            type: "session:mode",
            data: { mode: "play", variant: previousVariant },
          });
          if (modeResult.summary) {
            this.engine.setPendingOOCSummary(modeResult.summary);
          }
          scopedBroadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
          if (modeResult.playerAction && this.gameState) {
            const active = getActivePlayer(this.gameState);
            try {
              await this.engine.processInput(active.characterName, modeResult.playerAction);
            } catch (err) {
              if (err instanceof RollbackCompleteError) {
                scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
                scopedBroadcast({
                  type: "narrative:chunk",
                  data: { text: `[${err.message}]`, kind: "system" },
                });
                await this.endSession("rollback");
                return;
              }
              throw err;
            }
            this.persistTurnState();
            scopedBroadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
          }
          this.openNextTurn();
          return;
        }

        scopedBroadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
        this.openNextTurn();
        return;
      }

      // Normal play: send to DM
      const active = getActivePlayer(this.gameState);
      this.syncUIState();
      try {
        await this.engine.processInput(active.characterName, text);
      } catch (err) {
        // DM-initiated rollback throws RollbackCompleteError from inside
        // processInput; same handling as the mode-session path above.
        // Flush any buffered DM deltas with narrative:complete before the
        // system message so the client doesn't stay stuck in "streaming"
        // state while teardown runs.
        if (err instanceof RollbackCompleteError) {
          scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
          scopedBroadcast({
            type: "narrative:chunk",
            data: { text: `[${err.message}]`, kind: "system" },
          });
          await this.endSession("rollback");
          return;
        }
        // Session-fatal mid-game (issue #529): auth expired, model not
        // found, etc. Player can fix and start again, but this turn is
        // dead and the in-flight stream needs closing before teardown so
        // the client doesn't sit in "streaming" forever. Order matters:
        //   1. narrative:complete flushes any half-rendered DM deltas.
        //   2. endSession("session_fatal") triggers flush + checkpoint so
        //      the campaign resumes cleanly (no lost prior turns).
        //   3. broadcast the error with the new category — sent *after*
        //      session:ended so the client has already transitioned out
        //      of playing-phase state.
        if (this.isSessionFatal(err)) {
          await this.handleSessionFatal(err, scopedBroadcast);
          return;
        }
        throw err;
      }
      this.persistTurnState();
      scopedBroadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
      this.openNextTurn();
    });

    // --- Resume or start new ---
    // startNewGame runs the opening DM turn inline here — outside the
    // player-input commit handler that classifies session-fatal failures and
    // drops to menu. An auth failure on that very first turn (a dead ChatGPT
    // sign-in, a missing model) would otherwise bubble to startSession's
    // catch and surface as a dead "retry" overlay over an already-torn-down
    // session. Route session-fatal errors through the same graceful teardown
    // the mid-game path uses; non-fatal errors rethrow to preserve the
    // existing start-failure handling (REST 400 / retryable overlay). See
    // issue #558.
    try {
      if (isResume) {
        await this.resumeSession(engine, config, gs, scene);
      } else {
        await this.startNewGame(engine, config, gs, entityTree);
      }
    } catch (err) {
      if (this.isSessionFatal(err)) {
        await this.handleSessionFatal(err, scopedBroadcast);
        return;
      }
      throw err;
    }
  }

  /** Resume an existing campaign session. */
  private async resumeSession(
    engine: GameEngine,
    config: CampaignConfig,
    gs: GameState,
    scene: SceneState,
  ): Promise<void> {
    const persister = engine.getPersister();
    if (!persister) return;

    // Load and hydrate persisted state
    const loaded = await persister.loadAll();

    // Hydrate game state slices
    if (loaded.combat) Object.assign(gs.combat, loaded.combat);
    if (loaded.clocks) Object.assign(gs.clocks, loaded.clocks);
    if (loaded.maps) gs.maps = loaded.maps as typeof gs.maps;
    if (loaded.decks) Object.assign(gs.decks, loaded.decks);
    if (loaded.objectives) Object.assign(gs.objectives, loaded.objectives);
    if (loaded.resources) {
      if (loaded.resources.displayResources) gs.displayResources = loaded.resources.displayResources;
      if (loaded.resources.resourceValues) gs.resourceValues = loaded.resources.resourceValues;
    }
    if (loaded.scene?.activePlayerIndex != null) {
      gs.activePlayerIndex = loaded.scene.activePlayerIndex;
    }

    // Hydrate scene state fields that detectSceneState() doesn't read.
    // The scene object is shared by reference with the engine, so mutating
    // it here updates the engine's copy too.
    if (loaded.scene) {
      if (loaded.scene.precis !== undefined) scene.precis = loaded.scene.precis ?? "";
      if (loaded.scene.openThreads !== undefined) scene.openThreads = loaded.scene.openThreads ?? "";
      if (loaded.scene.npcIntents !== undefined) scene.npcIntents = loaded.scene.npcIntents ?? "";
      if (loaded.scene.playerReads != null) scene.playerReads = loaded.scene.playerReads;
      scene.sessionRecapPending = loaded.scene.sessionRecapPending === true;
    }

    // Capture persisted UI state (theme, modelines) for snapshots
    if (loaded.ui) {
      this.persistedUI = {
        themeName: loaded.ui.styleName,
        variant: loaded.ui.variant,
        keyColor: loaded.ui.keyColor,
        modelines: loaded.ui.modelines,
      };
    }

    // Seed cost tracker from persisted usage
    if (loaded.usage && this.costTracker) {
      this.costTracker.seed(loaded.usage);
    }

    // Seed conversation history
    if (loaded.conversation) {
      engine.seedConversation(loaded.conversation);
    }

    // Resume any interrupted scene transition
    const pendingOp = await persister.loadPendingOp();
    if (pendingOp && pendingOp.step && pendingOp.step !== "done") {
      await engine.resumePendingTransition(pendingOp);
    }

    // Sync UI state so the DM's resume narration sees current modelines
    this.syncUIState();

    // Get session recap. Non-empty only when the previous session ended
    // cleanly (sessionEnd set the pending flag and sessionResume consumed it).
    // Mid-session reconnects return "" so no modal is shown.
    const recap = await engine.resumeSession();
    if (recap) {
      this.pendingSessionRecap = {
        id: `session-${scene.sessionNumber - 1}`,
        lines: recap.split("\n"),
      };
    }

    // Broadcast state snapshot — carries sessionRecap exactly once when set.
    this.broadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });

    // Send display history from previous session as a single chunk per kind-group.
    // Joining lines with \n lets appendDelta handle paragraph spacing correctly.
    const historyLines = await persister.loadDisplayLogFull();
    if (historyLines.length > 0) {
      const narrativeLines = markdownToNarrativeLines(historyLines);
      // Seed the committed transcript with dm/player lines from history so a
      // mid-session rollback after resume produces a snapshot that contains
      // the prior session's text — not just lines accumulated since this load.
      // Skip separators/spacers/system/dev: those are presentation-only and
      // re-derived (or simply absent post-replace, which is acceptable).
      for (const line of narrativeLines) {
        if (line.kind === "dm" || line.kind === "player") {
          this.committedNarrative.push({ kind: line.kind, text: line.text });
        }
      }
      // Group consecutive same-kind lines and send each group as one chunk.
      // Separators (---) are sent as DM lines — the formatting pipeline
      // converts them to styled horizontal rules during rendering.
      let currentKind = "";
      let currentText = "";
      for (const line of narrativeLines) {
        let kind = line.kind as string;
        let text = line.text;
        // Convert separators to DM lines with --- text for the formatting pipeline
        if (kind === "separator") {
          kind = "dm";
          text = "---";
        }
        if (kind !== "dm" && kind !== "player" && kind !== "system" && kind !== "dev") continue;
        if (kind !== currentKind && currentText) {
          this.broadcast({ type: "narrative:chunk", data: { text: currentText, kind: currentKind as "dm" | "player" | "system" | "dev" } });
          currentText = "";
        }
        currentKind = kind;
        currentText += (currentText ? "\n" : "") + text;
      }
      if (currentText) {
        this.broadcast({ type: "narrative:chunk", data: { text: currentText, kind: currentKind as "dm" | "player" | "system" | "dev" } });
      }
      this.broadcast({ type: "narrative:complete", data: { text: "" } });
    }

    // Welcome message
    this.broadcast({
      type: "narrative:chunk",
      data: { text: `Welcome back to ${config.name}.`, kind: "system" },
    });

    // Session recap is delivered via sessionRecap in the state:snapshot above;
    // the client renders it as SessionRecapModal, not narrative text.

    // Open first turn
    this.openNextTurn();
  }

  /** Start a fresh game. */
  private async startNewGame(
    engine: GameEngine,
    config: CampaignConfig,
    gs: GameState,
    entityTree: EntityTree,
  ): Promise<void> {
    // Trigger opening scene — TUI commands (theme, resources, modelines)
    // stream live to the client as activity:update events during this call.
    //
    // Priming message layout:
    //   1. Bracketed stage direction: "[Session begins. Set the scene. <premise>. <PC>.]"
    //      This is the cue the DM is trained to react to.
    //   2. If the setup agent wrote a handoff note, a blank line + the note verbatim.
    //      The note carries the player's own words and any setup-agent notes that
    //      don't survive into structured config. It's a one-shot read; after the
    //      opening turn succeeds it remains in config.json purely for resume.
    //   3. A "Pre-existing entities" block listing every entity file already on
    //      disk after setup scaffolding. This is the "chain of custody" the DM
    //      relies on to avoid creating duplicate files (e.g. writing a fresh
    //      character sheet at `Janey Bruce.md` when `janey-bruce.md` already
    //      exists). Always included when the tree is non-empty.
    const active = getActivePlayer(gs);
    const openingParts = ["[Session begins. Set the scene."];
    if (config.premise) openingParts.push(`Campaign premise: ${config.premise}`);
    const pc = config.players[0];
    if (pc) openingParts.push(`The player character is ${pc.character}.`);
    let priming = openingParts.join(" ") + "]";
    if (config.setup_handoff && config.setup_handoff.trim()) {
      priming += "\n\nSetup agent's handoff note:\n" + config.setup_handoff.trim();
    }
    const entityListing = renderEntityTree(entityTree);
    if (entityListing) {
      priming += "\n\nPre-existing entities (created during setup — write to these paths,"
        + " do not create duplicates under alternate names):\n"
        + entityListing
        + "\n\nThe `Starting Location` entry is a placeholder. The first time"
        + " your opening narration names the locale, dispatch a Scribe update"
        + " naming the location — the Scribe will call `rename_entity` to move"
        + " the placeholder to the real name and rewrite any wikilinks.";
    }

    this.syncUIState();
    await engine.processInput(
      active.characterName,
      priming,
      { skipTranscript: true },
    );

    // Persist resources and UI state set during the opening turn.
    this.persistTurnState();

    // Authoritative snapshot — sent AFTER the DM's opening turn so it
    // contains fully populated resources, theme, modelines, and player data.
    // The client treats this as the definitive state, overwriting any
    // incremental patches it assembled from activity:update events.
    this.broadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });

    // Open first turn after DM narrates
    this.openNextTurn();
  }

  /** Open a turn for the current active player(s). */
  private openNextTurn(): void {
    if (!this.turnManager || !this.gameState) return;
    // Cancel any open turn that was never contributed to (e.g., a choice
    // modal was shown instead of collecting free-text input)
    const current = this.turnManager.getCurrentTurn();
    if (current && current.status === "open") {
      this.turnManager.cancelTurn();
    }
    const active = getActivePlayer(this.gameState);
    const humanPlayers = [active.characterName];
    const aiPlayers: string[] = [];
    this.turnManager.openTurn(humanPlayers, aiPlayers);
  }

  // --- Idle timeout ---

  /** Returns true if no player-role clients are connected. */
  private hasNoPlayers(): boolean {
    for (const { identity } of this.clients.values()) {
      if (identity.role === "player") return false;
    }
    return true;
  }

  /** Start the idle timer if there's an active session with no players. */
  private checkIdleTimeout(): void {
    if (this.status !== "active" || !this.hasNoPlayers()) return;
    if (this.idleTimer) return; // already ticking

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.status === "active" && this.hasNoPlayers()) {
        void this.endSession("idle_timeout");
      }
    }, SessionManager.IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** End the current session gracefully. */
  async endSession(reason: EndSessionReason = "explicit"): Promise<void> {
    if (this.status === "idle" || this.status === "stopping") return;

    // If a start is still in progress, wait for it to finish so we can
    // cleanly tear down the fully-initialised session.
    if (this.status === "starting") {
      while (this.status === "starting") {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Re-check: may have become idle via another path (e.g. setup error)
      if (this.status === "idle") return;
    }

    this.status = "stopping";
    this.clearIdleTimer();
    if (this.campaignId) {
      logEvent("session:end", { reason, campaignId: this.campaignId });
    }

    // Stop the context dump writer so fire-and-forget writes don't hold
    // file locks while git's statusMatrix walks the campaign tree.
    const { resetContextDump } = await import("../config/context-dump.js");
    resetContextDump();

    try {
      // Flush any pending state, with a timeout so a hanging flush
      // can never permanently brick the session lifecycle.
      //
      // Skip this block when ending due to a rollback: disk has just been
      // reset to the target commit, but the engine's in-memory state
      // (ConversationManager, SceneState) is still ahead by the rolled-back
      // turns. A flush+checkpoint here would persist that stale state and
      // silently undo the rollback for whole-file artifacts like
      // conversation.json and scene.json.
      if (this.engine && reason !== "rollback") {
        const timeout = (ms: number) => new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("endSession flush timeout")), ms));
        const persister = this.engine.getPersister();
        if (persister) await Promise.race([persister.flush(), timeout(10_000)]);
        const repo = this.engine.getRepo();
        if (repo) await Promise.race([repo.checkpoint("Session end"), timeout(10_000)]);
      }
    } catch (err) {
      logEvent("session:error", {
        phase: "cleanup",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    // Drain usage subscriptions before disposing providers so the
    // unsubscribe callback (which removes from the provider's listener
    // set) can't race with subprocess teardown.
    for (const unsub of this.usageUnsubscribers) {
      try { unsub(); } catch { /* best-effort */ }
    }
    this.usageUnsubscribers = [];
    this.lastUsageStatus = null;

    // Dispose stateful providers (openai-chatgpt subprocess teardown).
    // Each provider's dispose is idempotent and best-effort — errors are
    // logged but never block session teardown.
    const providersToDispose = Array.from(this.sessionProviders);
    this.sessionProviders.clear();
    this.providersByConnectionId.clear();
    await Promise.all(providersToDispose.map(async (p) => {
      if (p.dispose) {
        try {
          await p.dispose();
        } catch (err) {
          logEvent("provider:dispose_error", {
            providerId: p.providerId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }));

    // Dispose the setup-session's tier providers alongside the game
    // session's. endSession is called when the user ends from either
    // setup or play, so a lingering setup-session must shed its
    // subprocess too.
    const setupToDispose = this.setupSession;

    this.campaignId = null;
    this.turnManager = null;
    this.engine = null;
    this.gameState = null;
    this.setupSession = null;
    this.costTracker = null;
    if (setupToDispose) await setupToDispose.dispose();
    this.currentMode = "play";
    this.persistedUI = {};
    this.status = "idle";

    this.broadcast({
      type: "discord:presence",
      data: { action: "stop" },
    });

    // Push a final snapshot so any client still tracking mode state sees the
    // authoritative reset to "play" before the session winds down. Without
    // this, teardown paths that null the engine's mode session (e.g. the OOC
    // rollback path that calls endSession("rollback") from the commit handler)
    // leave clients believing they're still in OOC/Dev — the next ESC sends
    // /exit_mode against a dead session and surfaces "Not in a mode session."
    // instead of opening the menu.
    this.broadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });

    this.broadcast({
      type: "session:ended",
      data: { summary: "Session ended." },
    });
  }

  // --- Turn management ---

  getTurnManager(): TurnManager | null {
    return this.turnManager;
  }

  // --- State ---

  /** Persist resources and UI state after a DM turn completes. */
  private persistTurnState(): void {
    const persister = this.engine?.getPersister();
    if (!persister || !this.gameState) return;

    persister.persistResources({
      displayResources: this.gameState.displayResources,
      resourceValues: this.gameState.resourceValues,
    });
    persister.persistUI({
      styleName: this.persistedUI.themeName ?? "clean",
      variant: (this.persistedUI.variant as StyleVariant) ?? "exploration",
      keyColor: this.persistedUI.keyColor,
      modelines: this.persistedUI.modelines,
    });
  }

  /**
   * Push current UI state (modelines, theme, variant) into the engine's
   * session state so the DM's volatile context reflects what's on screen.
   * Call before each engine.processInput() so the DM sees its own modelines.
   */
  private syncUIState(): void {
    if (!this.engine) return;
    this.engine.setUIState(buildUIState({
      modelines: this.persistedUI.modelines ?? {},
      styleName: this.persistedUI.themeName ?? "clean",
      variant: this.persistedUI.variant ?? "exploration",
    }));
  }

  /** Keep persistedUI in sync with TUI commands so snapshots are always accurate. */
  private trackTuiState(cmd: { type: string; [key: string]: unknown }): void {
    switch (cmd.type) {
      case "set_theme":
        if (cmd.theme) this.persistedUI.themeName = cmd.theme as string;
        if (cmd.key_color) this.persistedUI.keyColor = cmd.key_color as string;
        if (cmd.variant) this.persistedUI.variant = cmd.variant as string;
        break;
      case "style_scene":
        // style_scene carries a variant; theme/key_color are resolved by the
        // set_theme command that follows (emitted by handleStyleSceneTool).
        if (cmd.variant) this.persistedUI.variant = cmd.variant as string;
        break;
      case "update_modeline": {
        const character = cmd.character as string | undefined;
        const text = cmd.text as string | undefined;
        if (character && text !== undefined) {
          if (!this.persistedUI.modelines) this.persistedUI.modelines = {};
          this.persistedUI.modelines[character] = text;
        }
        break;
      }
    }
  }

  /**
   * Push a multi-line text blob into the committed transcript as one entry
   * per `\n`-separated line — matching the per-line shape that
   * `appendDelta` produces during live streaming and that
   * `markdownToNarrativeLines` produces from the on-disk log on resume.
   * Empty splits ARE preserved: they render as blank lines, which act as
   * paragraph boundaries in the formatting pipeline.
   */
  private appendCommittedLines(kind: "dm" | "player", text: string): void {
    for (const line of text.split("\n")) {
      this.committedNarrative.push({ kind, text: line });
    }
  }

  /**
   * Build a state snapshot for broadcast.
   *
   * @param opts.includeNarrative — when true, include the committed transcript
   *   (DM + player lines). The client treats this as authoritative and
   *   REPLACES its accumulated narrative log. Pass true on connect (so
   *   reconnecting clients see history) and on retry rollback (to discard
   *   a partial DM stream that's about to be re-issued). Default false:
   *   per-turn snapshots omit narrative so they don't clobber in-flight
   *   stream deltas with a stale committed view.
   */
  buildStateSnapshot(opts?: { includeNarrative?: boolean }): StateSnapshot {
    const gs = this.gameState;
    const config = gs?.config;

    // Consume the one-shot recap: include it in this snapshot and clear so
    // subsequent snapshots (e.g. after each DM turn) don't re-open the modal.
    const recap = this.pendingSessionRecap;
    this.pendingSessionRecap = null;

    return {
      campaignId: this.campaignId ?? "",
      campaignName: config?.name ?? "",
      system: config?.system,
      players: config?.players.map((p) => ({
        name: p.name,
        character: p.character,
        type: p.type,
        color: p.color,
      })) ?? [],
      activePlayerIndex: gs?.activePlayerIndex ?? 0,
      displayResources: gs?.displayResources ?? {},
      resourceValues: gs?.resourceValues ?? {},
      modelines: this.persistedUI.modelines ?? {},
      themeName: this.persistedUI.themeName,
      variant: this.persistedUI.variant,
      keyColor: this.persistedUI.keyColor ?? undefined,
      mode: this.currentMode,
      sessionRecap: recap ?? undefined,
      narrativeLines: opts?.includeNarrative
        ? this.committedNarrative.slice()
        : undefined,
    };
  }

  /**
   * Does this thrown error mean the in-flight session is done — but the
   * process is fine and the player can fix something and try again?
   *
   * Recognises {@link CodexTurnFailedError} today; future provider error
   * classes that should drop to menu (Anthropic 403 on forbidden model,
   * setup-conversation refusal with empty content, etc.) should be added
   * to {@link classifyServerError} rather than branched on here.
   */
  private isSessionFatal(err: unknown): boolean {
    return classifyServerError(err) === "session-fatal-recoverable";
  }

  /**
   * Mid-game session-fatal teardown. Delegates to
   * {@link performSessionFatalTeardown} so the sequencing (flush →
   * endSession → broadcast) can be unit-tested without a real engine.
   */
  private async handleSessionFatal(
    err: unknown,
    scopedBroadcast: (event: ServerEvent) => void,
  ): Promise<void> {
    await performSessionFatalTeardown({
      err,
      scopedBroadcast,
      unscopedBroadcast: (event) => this.broadcast(event),
      endSession: () => this.endSession("session_fatal"),
    });
  }

  /** Teardown on server shutdown. */
  async teardown(): Promise<void> {
    if (this.status !== "idle") {
      await this.endSession();
    }
    for (const { ws } of this.clients.values()) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
  }
}
