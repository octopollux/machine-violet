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
import { createClient } from "../config/client.js";
import { loadEnv } from "../config/first-launch.js";
import { sandboxFileIO } from "../tools/filesystem/sandbox.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";
import { createGitIO } from "../tools/git/isogit-adapter.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { TurnManager } from "./turn-manager.js";
import { createBridge } from "./bridge.js";
import { createBaseFileIO } from "./fileio.js";

export interface ConnectedClient {
  ws: WebSocket;
  identity: ConnectionIdentity;
}

export class SessionManager {
  private campaignsDir: string;
  private clients = new Map<WebSocket, ConnectedClient>();
  private turnManager: TurnManager | null = null;
  private active = false;
  private engine: GameEngine | null = null;
  private gameState: GameState | null = null;

  /** Campaign ID of the currently active session (null if none). */
  private campaignId: string | null = null;

  constructor(campaignsDir: string) {
    this.campaignsDir = campaignsDir;
  }

  // --- Connection management ---

  addClient(ws: WebSocket, identity: ConnectionIdentity): void {
    this.clients.set(ws, { ws, identity });

    ws.on("close", () => {
      this.clients.delete(ws);
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
  }

  // --- Broadcasting ---

  broadcast(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  sendTo(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  broadcastToPlayers(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const { ws, identity } of this.clients.values()) {
      if (identity.role === "player" && ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  // --- Session lifecycle ---

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

    // --- Create Anthropic client ---
    const client = createClient();

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

    // --- Create bridge (EngineCallbacks → WebSocket events) ---
    const callbacks = createBridge((event) => this.broadcast(event));

    // --- Instantiate GameEngine ---
    const engine = new GameEngine({
      client,
      gameState: gs,
      scene,
      sessionState,
      fileIO,
      callbacks,
      gitIO,
    });

    this.engine = engine;
    this.gameState = gs;
    this.campaignId = campaignId;
    this.active = true;

    // --- Initialize turn manager ---
    this.turnManager = new TurnManager((event) => this.broadcast(event));
    this.turnManager.setCommitHandler(async (contributions) => {
      if (!this.engine || !this.gameState) return;
      // Assemble contributions into a single input
      const text = contributions.map((c) => c.text).join("\n");
      const active = getActivePlayer(this.gameState);
      await this.engine.processInput(active.characterName, text);
      // Open the next turn after DM responds
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
    _scene: SceneState,
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

    // Broadcast session start
    this.broadcast({ type: "state:snapshot", data: this.buildStateSnapshot() });
    this.broadcast({
      type: "narrative:chunk",
      data: { text: `Welcome back to ${config.name}.`, kind: "system" },
    });
    if (recap) {
      this.broadcast({
        type: "modal:show",
        data: { type: "recap", id: "session-recap", lines: recap.split("\n") },
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
    const active = getActivePlayer(this.gameState);
    const humanPlayers = [active.characterName];
    const aiPlayers: string[] = []; // AI players not yet implemented
    this.turnManager.openTurn(humanPlayers, aiPlayers);
  }

  /** End the current session gracefully. */
  async endSession(): Promise<void> {
    if (!this.active) return;

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
      modelines: {},
      mode: "play",
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
