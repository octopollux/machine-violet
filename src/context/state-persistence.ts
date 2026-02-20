import { join } from "node:path";
import { norm } from "../utils/paths.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { CombatState } from "../types/combat.js";
import type { ClocksState } from "../types/clocks.js";
import type { DecksState } from "../types/cards.js";
import type { MapData } from "../types/maps.js";
import type { SceneState } from "../agents/scene-manager.js";
import type { SerializedExchange } from "./conversation.js";
import type { StyleVariant } from "../types/tui.js";

/** Paths within campaign root for persisted state files */
export const STATE_FILES = {
  combat: "state/combat.json",
  clocks: "state/clocks.json",
  maps: "state/maps.json",
  decks: "state/decks.json",
  scene: "state/scene.json",
  conversation: "state/conversation.json",
  ui: "state/ui.json",
} as const;

export type StateSlice = "combat" | "clocks" | "maps" | "decks";

/** Scene state subset that gets persisted */
export interface PersistedSceneState {
  precis: string;
  playerReads: SceneState["playerReads"];
  activePlayerIndex: number;
}

/** UI theme state that gets persisted */
export interface PersistedUIState {
  styleName: string;
  variant: StyleVariant;
}

/** Full loaded state from disk */
export interface LoadedState {
  combat?: CombatState;
  clocks?: ClocksState;
  maps?: Record<string, MapData>;
  decks?: DecksState;
  scene?: PersistedSceneState;
  conversation?: SerializedExchange[];
  ui?: PersistedUIState;
}

/**
 * Write-through state persister.
 * Each persist call is fire-and-forget with error swallowing.
 */
export class StatePersister {
  private root: string;
  private fileIO: FileIO;

  constructor(campaignRoot: string, fileIO: FileIO) {
    this.root = campaignRoot;
    this.fileIO = fileIO;
  }

  private path(file: string): string {
    return norm(join(this.root, file));
  }

  private async writeJSON(file: string, data: unknown): Promise<void> {
    try {
      await this.fileIO.writeFile(this.path(file), JSON.stringify(data, null, 2));
    } catch {
      // Fire-and-forget: best-effort persistence
    }
  }

  private async readJSON<T>(file: string): Promise<T | undefined> {
    try {
      const raw = await this.fileIO.readFile(this.path(file));
      if (!raw) return undefined;
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  persistCombat(state: CombatState): void {
    void this.writeJSON(STATE_FILES.combat, state);
  }

  persistClocks(state: ClocksState): void {
    void this.writeJSON(STATE_FILES.clocks, state);
  }

  persistMaps(state: Record<string, MapData>): void {
    void this.writeJSON(STATE_FILES.maps, state);
  }

  persistDecks(state: DecksState): void {
    void this.writeJSON(STATE_FILES.decks, state);
  }

  persistScene(scene: PersistedSceneState): void {
    void this.writeJSON(STATE_FILES.scene, scene);
  }

  persistConversation(exchanges: SerializedExchange[]): void {
    void this.writeJSON(STATE_FILES.conversation, exchanges);
  }

  persistUI(state: PersistedUIState): void {
    void this.writeJSON(STATE_FILES.ui, state);
  }

  /** Delete conversation state (called on clean session boundary) */
  async clearConversation(): Promise<void> {
    try {
      await this.fileIO.writeFile(this.path(STATE_FILES.conversation), "");
    } catch {
      // best-effort
    }
  }

  /** Load all persisted state files. Missing files return undefined per key. */
  async loadAll(): Promise<LoadedState> {
    const [combat, clocks, maps, decks, scene, conversation, ui] = await Promise.all([
      this.readJSON<CombatState>(STATE_FILES.combat),
      this.readJSON<ClocksState>(STATE_FILES.clocks),
      this.readJSON<Record<string, MapData>>(STATE_FILES.maps),
      this.readJSON<DecksState>(STATE_FILES.decks),
      this.readJSON<PersistedSceneState>(STATE_FILES.scene),
      this.readJSON<SerializedExchange[]>(STATE_FILES.conversation),
      this.readJSON<PersistedUIState>(STATE_FILES.ui),
    ]);

    return { combat, clocks, maps, decks, scene, conversation, ui };
  }
}
