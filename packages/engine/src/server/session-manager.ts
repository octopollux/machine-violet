/**
 * Session manager — holds one active game session per process.
 *
 * Manages WebSocket connections (players + spectators), routes
 * messages between the engine and connected clients, and handles
 * session lifecycle (start, teardown).
 *
 * The actual GameEngine integration is deferred to Phase 2a
 * (engine code move). For now, this defines the interface and
 * handles connection management.
 */
import type { WebSocket } from "ws";
import type {
  ServerEvent,
  ConnectionIdentity,
  StateSnapshot,
} from "@machine-violet/shared";
import { TurnManager } from "./turn-manager.js";

export interface ConnectedClient {
  ws: WebSocket;
  identity: ConnectionIdentity;
}

export class SessionManager {
  private campaignsDir: string;
  private clients = new Map<WebSocket, ConnectedClient>();
  private turnManager: TurnManager | null = null;
  private active = false;

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

  /** Send a server event to all connected clients. */
  broadcast(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  /** Send a server event to a specific client. */
  sendTo(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /** Send to all player connections (not spectators). */
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

  /** Start a new game session for the given campaign. */
  async startSession(campaignId: string): Promise<void> {
    if (this.active) {
      throw new Error("A session is already active. End it before starting a new one.");
    }
    this.campaignId = campaignId;
    this.active = true;

    // Initialize turn manager
    this.turnManager = new TurnManager((event) => this.broadcast(event));

    // TODO: Phase 2a — instantiate real GameEngine here
    // - Load CampaignConfig from campaignsDir/campaignId/config.json
    // - Create GameState, SceneState, FileIO, GitIO
    // - Create GameEngine with bridge callbacks (see bridge.ts)
    // - Call engine.resumeSession() or start new game
  }

  /** End the current session gracefully. */
  async endSession(): Promise<void> {
    if (!this.active) return;

    // TODO: Phase 2a — call engine.endSession() and teardown

    this.active = false;
    this.campaignId = null;
    this.turnManager = null;

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

  /** Build a full state snapshot for client consumption. */
  buildStateSnapshot(): StateSnapshot {
    // TODO: Phase 2a — build from real GameState + SceneState
    return {
      campaignId: this.campaignId ?? "",
      campaignName: "",
      players: [],
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
      modelines: {},
      mode: "play",
    };
  }

  /** Teardown on server shutdown. */
  async teardown(): Promise<void> {
    if (this.active) {
      await this.endSession();
    }
    // Close all WebSocket connections
    for (const { ws } of this.clients.values()) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
  }
}
