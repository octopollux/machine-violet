import { join } from "node:path";
import { norm } from "../utils/paths.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { CombatState } from "../types/combat.js";
import type { ClocksState } from "../types/clocks.js";
import type { DecksState } from "../types/cards.js";
import type { ObjectivesState } from "../types/objectives.js";
import type { MapData } from "../types/maps.js";
import type { SceneState } from "../agents/scene-manager.js";
import type { ConversationExchange } from "./conversation.js";
import type { StyleVariant } from "../types/tui.js";
import type { TokenBreakdown } from "./cost-tracker.js";
import { tailLines } from "./display-log.js";

/** Paths within campaign root for persisted state files */
export const STATE_FILES = {
  combat: "state/combat.json",
  clocks: "state/clocks.json",
  maps: "state/maps.json",
  decks: "state/decks.json",
  objectives: "state/objectives.json",
  scene: "state/scene.json",
  conversation: "state/conversation.json",
  ui: "state/ui.json",
  usage: "state/usage.json",
  resources: "state/resources.json",
  displayLog: "state/display-log.md",
} as const;

export type StateSlice = "combat" | "clocks" | "maps" | "decks" | "objectives";

/** Scene state subset that gets persisted */
export interface PersistedSceneState {
  precis: string;
  openThreads?: string;
  npcIntents?: string;
  playerReads: SceneState["playerReads"];
  activePlayerIndex: number;
}

/** UI theme state that gets persisted */
export interface PersistedUIState {
  styleName: string;
  variant: StyleVariant;
  keyColor?: string;
  modelines?: Record<string, string>;
}

/** Persisted resource display + values */
export interface PersistedResourceState {
  displayResources: Record<string, string[]>;
  resourceValues: Record<string, Record<string, string>>;
}

/** Full loaded state from disk */
export interface LoadedState {
  combat?: CombatState;
  clocks?: ClocksState;
  maps?: Record<string, MapData>;
  decks?: DecksState;
  objectives?: ObjectivesState;
  scene?: PersistedSceneState;
  conversation?: ConversationExchange[];
  ui?: PersistedUIState;
  usage?: TokenBreakdown;
  resources?: PersistedResourceState;
}

/**
 * Write-through state persister.
 * Each persist call is fire-and-forget with error swallowing.
 * Writes to the same file are serialized via per-file promise chains;
 * writes to different files proceed concurrently.
 */
export class StatePersister {
  private root: string;
  private fileIO: FileIO;
  private onError?: (error: Error) => void;
  private writeQueues = new Map<string, Promise<void>>();

  constructor(campaignRoot: string, fileIO: FileIO, onError?: (error: Error) => void) {
    this.root = campaignRoot;
    this.fileIO = fileIO;
    this.onError = onError;
  }

  private path(file: string): string {
    return norm(join(this.root, file));
  }

  private async doWrite(file: string, content: string): Promise<void> {
    try {
      await this.fileIO.writeFile(this.path(file), content);
    } catch (e) {
      // Fire-and-forget: best-effort persistence
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private enqueueWrite(file: string, content: string): void {
    const prev = this.writeQueues.get(file) ?? Promise.resolve();
    const next = prev.then(() => this.doWrite(file, content)).catch(() => { /* fire-and-forget */ });
    this.writeQueues.set(file, next);
  }

  private async doAppend(file: string, content: string): Promise<void> {
    try {
      await this.fileIO.appendFile(this.path(file), content);
    } catch (e) {
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private enqueueAppend(file: string, content: string): void {
    const prev = this.writeQueues.get(file) ?? Promise.resolve();
    const next = prev.then(() => this.doAppend(file, content)).catch(() => { /* fire-and-forget */ });
    this.writeQueues.set(file, next);
  }

  /** Wait for all pending writes to complete. */
  async flush(): Promise<void> {
    await Promise.all(this.writeQueues.values());
  }

  private async readJSON<T>(file: string): Promise<T | undefined> {
    try {
      const raw = await this.fileIO.readFile(this.path(file));
      if (!raw) return undefined;
      return JSON.parse(raw) as T;
    } catch (e) {
      // Missing files are expected (optional state that hasn't been written yet)
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      return undefined;
    }
  }

  persistCombat(state: CombatState): void {
    this.enqueueWrite(STATE_FILES.combat, JSON.stringify(state, null, 2));
  }

  persistClocks(state: ClocksState): void {
    this.enqueueWrite(STATE_FILES.clocks, JSON.stringify(state, null, 2));
  }

  persistMaps(state: Record<string, MapData>): void {
    this.enqueueWrite(STATE_FILES.maps, JSON.stringify(state, null, 2));
  }

  persistDecks(state: DecksState): void {
    this.enqueueWrite(STATE_FILES.decks, JSON.stringify(state, null, 2));
  }

  persistObjectives(state: ObjectivesState): void {
    this.enqueueWrite(STATE_FILES.objectives, JSON.stringify(state, null, 2));
  }

  persistScene(scene: PersistedSceneState): void {
    this.enqueueWrite(STATE_FILES.scene, JSON.stringify(scene, null, 2));
  }

  persistConversation(exchanges: ConversationExchange[]): void {
    this.enqueueWrite(STATE_FILES.conversation, JSON.stringify(exchanges));
  }

  persistResources(state: PersistedResourceState): void {
    this.enqueueWrite(STATE_FILES.resources, JSON.stringify(state, null, 2));
  }

  persistUI(state: PersistedUIState): void {
    this.enqueueWrite(STATE_FILES.ui, JSON.stringify(state, null, 2));
  }

  persistUsage(breakdown: TokenBreakdown): void {
    this.enqueueWrite(STATE_FILES.usage, JSON.stringify(breakdown, null, 2));
  }

  /** Append text to the rolling display log (human-readable, never cleared). */
  appendDisplayLog(text: string): void {
    this.enqueueAppend(STATE_FILES.displayLog, text);
  }

  /** Load the last N lines of the display log for TUI population on resume. */
  async loadDisplayLogTail(maxLines: number): Promise<string[]> {
    try {
      const raw = await this.fileIO.readFile(this.path(STATE_FILES.displayLog));
      if (!raw) return [];
      return tailLines(raw, maxLines);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      return [];
    }
  }

  /** Load the full display log for TUI population on resume (allows full backscroll). */
  async loadDisplayLogFull(): Promise<string[]> {
    try {
      const raw = await this.fileIO.readFile(this.path(STATE_FILES.displayLog));
      if (!raw) return [];
      return tailLines(raw, Infinity);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      return [];
    }
  }

  /** Load pending operation file (for crash recovery) */
  async loadPendingOp(): Promise<import("../agents/scene-manager.js").PendingOperation | undefined> {
    return this.readJSON<import("../agents/scene-manager.js").PendingOperation>("pending-operation.json");
  }

  /** Load all persisted state files. Missing files return undefined per key. */
  async loadAll(): Promise<LoadedState> {
    const [combat, clocks, maps, decks, objectives, scene, conversation, ui, usage, resources] = await Promise.all([
      this.readJSON<CombatState>(STATE_FILES.combat),
      this.readJSON<ClocksState>(STATE_FILES.clocks),
      this.readJSON<Record<string, MapData>>(STATE_FILES.maps),
      this.readJSON<DecksState>(STATE_FILES.decks),
      this.readJSON<ObjectivesState>(STATE_FILES.objectives),
      this.readJSON<PersistedSceneState>(STATE_FILES.scene),
      this.readJSON<ConversationExchange[]>(STATE_FILES.conversation),
      this.readJSON<PersistedUIState>(STATE_FILES.ui),
      this.readJSON<TokenBreakdown>(STATE_FILES.usage),
      this.readJSON<PersistedResourceState>(STATE_FILES.resources),
    ]);

    return { combat, clocks, maps, decks, objectives, scene, conversation, ui, usage, resources };
  }
}
