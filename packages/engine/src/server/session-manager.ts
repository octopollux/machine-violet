/**
 * Session manager — holds one active game session per process.
 *
 * Manages WebSocket connections (players + spectators), orchestrates
 * the GameEngine lifecycle, and routes messages between engine and clients.
 */
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import type {
  ServerEvent,
  ConnectionIdentity,
  StateSnapshot,
  CampaignConfig,
  GameState,
} from "@machine-violet/shared";
import { GameEngine } from "../agents/game-engine.js";
import type { SceneState } from "../agents/scene-manager.js";
import { detectSceneState } from "../agents/scene-manager.js";
import type { DMSessionState } from "../agents/dm-prompt.js";
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
import { createBridge } from "./bridge.js";
import { createBaseFileIO } from "./fileio.js";
import { SetupSession } from "./setup-session.js";

export interface ConnectedClient {
  ws: WebSocket;
  identity: ConnectionIdentity;
}

export class SessionManager {
  private campaignsDir: string;
  private clients = new Map<WebSocket, ConnectedClient>();
  private turnManager: TurnManager | null = null;
  private active = false;
  /** Incremented on each session start; stale callbacks check this to avoid leaking events. */
  private sessionGeneration = 0;
  private engine: GameEngine | null = null;
  private gameState: GameState | null = null;
  private costTracker: CostTracker | null = null;
  private currentMode: "play" | "ooc" | "dev" | "setup" = "play";
  private persistedUI: { themeName?: string; variant?: string; keyColor?: string; modelines?: Record<string, string> } = {};
  private setupSession: SetupSession | null = null;

  /** Campaign ID of the currently active session (null if none). */
  private campaignId: string | null = null;

  /** Timer that fires when no players have been connected for IDLE_TIMEOUT_MS. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(campaignsDir: string) {
    this.campaignsDir = campaignsDir;
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
    if (this.active) {
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
    if (this.active) throw new Error("A session is already active.");
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
      dm_personality: { name: "Setup MC", prompt: "" },
      players: [{ character: "Player", type: "human", color: "#ffffff" }],
      combat: { system: "theater_of_mind", grid_size: 0, default_initiative: "dex" },
      context: {},
      recovery: { auto_commit_interval: 0, max_commits: 0, enable_git: false },
      choices: { campaign_default: "sometimes", player_overrides: {} },
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
    this.active = true;
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
        await this.transitionToGame(result.finalized);
      } else {
        this.openNextTurn();
      }
    });

    // Start the setup conversation in the background
    const setup = this.setupSession;
    void setup.start().then(() => {
      if (this.setupSession === setup) this.openNextTurn();
    });
  }

  /** Resolve a choice during setup. */
  async resolveSetupChoice(selectedText: string): Promise<{ finalized?: string }> {
    if (!this.setupSession) throw new Error("No setup session.");
    const result = await this.setupSession.resolveChoice(selectedText);
    if (result.finalized) {
      await this.transitionToGame(result.finalized);
      return { finalized: result.finalized };
    }
    this.openNextTurn();
    return {};
  }

  getSetupSession(): SetupSession | null {
    return this.setupSession;
  }

  /** Transition from setup to a real game session. */
  private async transitionToGame(campaignId: string): Promise<void> {
    this.setupSession = null;
    this.turnManager = null;
    this.active = false;
    this.campaignId = null;
    this.currentMode = "play";

    // Start the newly created campaign
    await this.startSession(campaignId);
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentCampaignId(): string | null {
    return this.campaignId;
  }

  /** Start a game session for the given campaign. */
  async startSession(campaignId: string): Promise<void> {
    if (this.active) {
      throw new Error("A session is already active. End it before starting a new one.");
    }

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
    const fileIO = sandboxFileIO(baseIO, [campaignRoot, campaignsDir]);

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

    // --- Build entity tree from disk ---
    const entityTree = await buildEntityTree(campaignRoot, fileIO);

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
    const callbacks = createBridge({
      broadcast: scopedBroadcast,
      costTracker: this.costTracker,
      persister: null, // Will be set after engine creation
    });

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
    this.active = true;

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
        await modeSession.send(text, (delta) => {
          scopedBroadcast({ type: "narrative:chunk", data: { text: delta, kind: "dm" } });
        });
        scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
        this.openNextTurn();
        return;
      }

      // Normal play: send to DM
      const active = getActivePlayer(this.gameState);
      await this.engine.processInput(active.characterName, text);
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
      if (loaded.scene.precis) scene.precis = loaded.scene.precis;
      if (loaded.scene.openThreads) scene.openThreads = loaded.scene.openThreads;
      if (loaded.scene.npcIntents) scene.npcIntents = loaded.scene.npcIntents;
      if (loaded.scene.playerReads) scene.playerReads = loaded.scene.playerReads;
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

    // Get session recap
    const recap = await engine.resumeSession();

    // Broadcast state snapshot
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

    // Session recap as narrative (not a modal — client decides rendering)
    if (recap) {
      this.broadcast({
        type: "narrative:chunk",
        data: { text: recap, kind: "system" },
      });
    }

    // Open first turn
    this.openNextTurn();
  }

  /** Start a fresh game. */
  private async startNewGame(
    engine: GameEngine,
    config: CampaignConfig,
    gs: GameState,
  ): Promise<void> {
    // Broadcast session start
    this.broadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
    this.broadcast({
      type: "narrative:chunk",
      data: { text: `Welcome to ${config.name}. The story begins...`, kind: "system" },
    });

    // Trigger opening scene
    const active = getActivePlayer(gs);
    const openingParts = ["[Session begins. Set the scene."];
    if (config.premise) openingParts.push(`Campaign premise: ${config.premise}`);
    const pc = config.players[0];
    if (pc) openingParts.push(`The player character is ${pc.character}.`);

    await engine.processInput(
      active.characterName,
      openingParts.join(" ") + "]",
      { skipTranscript: true },
    );

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
    if (!this.active || !this.hasNoPlayers()) return;
    if (this.idleTimer) return; // already ticking

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active && this.hasNoPlayers()) {
        console.log("[SessionManager] No players for 5 minutes — saving and ending session");
        void this.endSession();
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
  async endSession(): Promise<void> {
    if (!this.active) return;
    this.clearIdleTimer();

    // Flush any pending state
    if (this.engine) {
      const persister = this.engine.getPersister();
      if (persister) await persister.flush();
      const repo = this.engine.getRepo();
      if (repo) await repo.checkpoint("Session end");
    }

    this.active = false;
    this.campaignId = null;
    this.turnManager = null;
    this.engine = null;
    this.gameState = null;
    this.setupSession = null;
    this.costTracker = null;
    this.currentMode = "play";
    this.persistedUI = {};

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

  buildStateSnapshot(): StateSnapshot {
    const gs = this.gameState;
    const config = gs?.config;

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
      keyColor: this.persistedUI.keyColor,
      mode: this.currentMode,
    };
  }

  /** Teardown on server shutdown. */
  async teardown(): Promise<void> {
    if (this.active) {
      await this.endSession();
    }
    for (const { ws } of this.clients.values()) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
  }
}
