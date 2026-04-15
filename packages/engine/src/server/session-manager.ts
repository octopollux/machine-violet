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
} from "@machine-violet/shared";
import { GameEngine } from "../agents/game-engine.js";
import { RollbackCompleteError } from "@machine-violet/shared/types/errors.js";
import type { SceneState } from "../agents/scene-manager.js";
import { detectSceneState, loadContentBoundaries } from "../agents/scene-manager.js";
import { buildUIState, type DMSessionState } from "../agents/dm-prompt.js";
import { buildNameInspiration } from "../agents/name-inspiration.js";
import { getActivePlayer } from "../agents/player-manager.js";
import { loadEnv } from "../config/first-launch.js";
import { loadConnectionStore, buildEffectiveConnections, getTierProvider } from "../config/connections.js";
import { createProviderFromConnection } from "../providers/index.js";
import { configDir } from "../utils/paths.js";
import { sandboxFileIO } from "../tools/filesystem/sandbox.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";
import { buildEntityTree } from "../tools/filesystem/entity-tree.js";
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

/** DM-narrative interval at which a fresh Discord presence string is generated. */
const DISCORD_STATUS_INTERVAL = 8;

export interface ConnectedClient {
  ws: WebSocket;
  identity: ConnectionIdentity;
}

export type SessionStatus = "idle" | "starting" | "active" | "stopping";

/**
 * Reasons a session can end. Drives teardown behavior — "rollback" skips
 * the flush+checkpoint that would otherwise clobber rolled-back disk state
 * with stale in-memory values. Keep this a closed union so new callsites
 * can't silently bypass the rollback-safe path with a typo'd string.
 */
export type EndSessionReason = "explicit" | "idle_timeout" | "rollback";

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
  private currentMode: "play" | "ooc" | "dev" | "setup" = "play";
  private persistedUI: { themeName?: string; variant?: string; keyColor?: string | null; modelines?: Record<string, string> | null } = {};
  /** One-shot recap payload: set during sessionResume, emitted in the next
   *  buildStateSnapshot() call and cleared. Ensures only the first snapshot
   *  after a clean session-end carries the recap. */
  private pendingSessionRecap: { id: string; lines: string[] } | null = null;
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
      this.checkIdleTimeout();
    });

    // Send current state snapshot on connect
    if (this.status === "active") {
      const snapshot = this.buildStateSnapshot();
      this.sendTo(ws, {
        type: "state:snapshot",
        data: snapshot,
      });
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.checkIdleTimeout();
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
      choices: { campaign_default: "none", player_overrides: {} },
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
      const result = await this.setupSession.send(text);
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

      // Tear down setup state so a new setup can be started
      this.setupSession = null;
      this.turnManager = null;
      this.status = "idle";

      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : String(err), recoverable: false },
      });
    });
  }

  /** Resolve a choice during setup. */
  async resolveSetupChoice(selectedText: string): Promise<{ finalized?: string }> {
    if (!this.setupSession) throw new Error("No setup session.");
    const result = await this.setupSession.resolveChoice(selectedText);
    if (result.finalized) {
      await this.transitionToGame(result.finalized, result.campaignName);
      return { finalized: result.finalized };
    }
    this.openNextTurn();
    return {};
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

    this.setupSession = null;
    this.turnManager = null;
    this.engine = null;
    this.gameState = null;
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

    // --- Resolve provider from connections ---
    const appConfigDir = configDir();
    const connStore = buildEffectiveConnections(loadConnectionStore(appConfigDir), appConfigDir);
    const largeTier = getTierProvider(connStore, "large");

    // Create provider from large tier, or fall back to Anthropic env key
    let provider;
    if (largeTier) {
      provider = createProviderFromConnection(largeTier.connection);
    } else {
      const { createAnthropicProvider } = await import("../providers/anthropic.js");
      provider = createAnthropicProvider();
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

    // Sample a fresh multicultural name pool to perturb the DM's naming
    // priors. Drawn once per session and held in DMSessionState so it
    // rides Tier 2 cache instead of churning per turn.
    sessionState.nameInspiration = buildNameInspiration();

    // --- Build entity tree from disk ---
    const entityTree = await buildEntityTree(campaignRoot, fileIO);

    // --- Load content boundaries from machine-scope player files ---
    try {
      sessionState.contentBoundaries = await loadContentBoundaries(
        config.players,
        homeDir,
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
    const scopedBroadcast = (event: ServerEvent) => {
      if (this.sessionGeneration !== gen) return;
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
          const { status, usage } = await generateDiscordStatus(provider, text);
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

    // --- Instantiate GameEngine ---
    const engine = new GameEngine({
      provider,
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
        try {
          await modeSession.send(text, (delta) => {
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
          throw err;
        }
        scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
        this.persistTurnState();
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
        throw err;
      }
      this.persistTurnState();
      scopedBroadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
      this.openNextTurn();
    });

    // --- Resume or start new ---
    if (isResume) {
      await this.resumeSession(engine, config, gs, scene);
    } else {
      await this.startNewGame(engine, config, gs);
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
  ): Promise<void> {
    // Trigger opening scene — TUI commands (theme, resources, modelines)
    // stream live to the client as activity:update events during this call.
    const active = getActivePlayer(gs);
    const openingParts = ["[Session begins. Set the scene."];
    if (config.premise) openingParts.push(`Campaign premise: ${config.premise}`);
    const pc = config.players[0];
    if (pc) openingParts.push(`The player character is ${pc.character}.`);

    this.syncUIState();
    await engine.processInput(
      active.characterName,
      openingParts.join(" ") + "]",
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

    this.campaignId = null;
    this.turnManager = null;
    this.engine = null;
    this.gameState = null;
    this.setupSession = null;
    this.costTracker = null;
    this.currentMode = "play";
    this.persistedUI = {};
    this.status = "idle";

    this.broadcast({
      type: "discord:presence",
      data: { action: "stop" },
    });

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

  buildStateSnapshot(): StateSnapshot {
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
    };
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
