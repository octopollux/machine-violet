import { buildScenePacing } from "./scene-manager.js";
import type { SceneState } from "./scene-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Terminal dimensions as reported by the TUI layer. */
export interface TerminalDims {
  columns: number;
  rows: number;
  /** Usable narrative-area rows (after subtracting UI chrome). */
  narrativeRows: number;
}

/** Read-only snapshot of state that injections inspect to decide what to emit. */
export interface InjectionContext {
  /** Number of exchanges currently in the conversation window. */
  conversationSize: number;
  /** Current scene state. */
  scene: SceneState;
  /** Whether this is a system-instruction turn (session open/resume). */
  skipTranscript: boolean;
  /** Terminal dimensions, or undefined if not yet reported by the TUI. */
  terminalDims: TerminalDims | undefined;
  /**
   * Rendered hard-stats string for this turn (turn holder, combat round,
   * resource values). HardStatsInjection compares against its last-emitted
   * copy to decide whether to re-emit ahead of cadence.
   */
  hardStatsText?: string;
}

/** Post-response information for updating internal counters. */
export interface ResponseInfo {
  text: string;
  toolUsed: boolean;
  fromAI: boolean;
  /** Number of wrapped lines the DM response occupies in the narrative area. */
  wrappedLineCount: number;
}

/** A single injectable preamble fragment. */
export interface Injection {
  /** Short identifier used in dev-log messages. */
  readonly name: string;
  /** Return injection text, or null to skip this turn. */
  build(ctx: InjectionContext): string | null;
  /** Called after each DM response so the injection can update counters. */
  afterResponse?(info: ResponseInfo): void;
}

// ---------------------------------------------------------------------------
// BehaviorInjection — nudges the DM to use tools and color-code entities
// ---------------------------------------------------------------------------

export class BehaviorInjection implements Injection {
  readonly name = "behavior";
  static readonly THRESHOLD = 3;
  private turnsWithoutTools = 0;
  private turnsWithoutEntities = 0;

  build(ctx: InjectionContext): string | null {
    if (ctx.skipTranscript) return null;
    if (ctx.conversationSize < BehaviorInjection.THRESHOLD) return null;
    const cues: string[] = [];
    if (this.turnsWithoutTools >= BehaviorInjection.THRESHOLD) cues.push("use your tools");
    if (this.turnsWithoutEntities >= BehaviorInjection.THRESHOLD) cues.push("color-code entity names");
    if (cues.length === 0) return null;
    return `[dm-note] ${cues.join("; ")}.`;
  }

  afterResponse(info: ResponseInfo): void {
    if (info.fromAI) return;
    this.turnsWithoutTools = info.toolUsed ? 0 : this.turnsWithoutTools + 1;
    const hasEntityLinks = /<color=[^>]+>[^<]+<\/color>/.test(info.text);
    this.turnsWithoutEntities = hasEntityLinks ? 0 : this.turnsWithoutEntities + 1;
  }

  /** Reset counters (called on scene transitions). */
  reset(): void {
    this.turnsWithoutTools = 0;
    this.turnsWithoutEntities = 0;
  }
}

// ---------------------------------------------------------------------------
// ScenePacingInjection — periodic nudge about scene length and open threads
// ---------------------------------------------------------------------------

export class ScenePacingInjection implements Injection {
  readonly name = "scene-pacing";

  build(ctx: InjectionContext): string | null {
    if (ctx.conversationSize === 0 || ctx.conversationSize % 3 !== 0) return null;
    const pacing = buildScenePacing(ctx.scene);
    if (!pacing) return null;
    return `[scene-pacing] ${pacing}`;
  }
}

// ---------------------------------------------------------------------------
// LengthSteeringInjection — terminal-size awareness + overlong reminders
// ---------------------------------------------------------------------------

export class LengthSteeringInjection implements Injection {
  readonly name = "length";
  private lastReportedDims: TerminalDims | undefined;
  private dimsInjectedOnce = false;
  private consecutiveOverlong = 0;
  static readonly OVERLONG_THRESHOLD = 2;

  build(ctx: InjectionContext): string | null {
    const dims = ctx.terminalDims;
    if (!dims) return null;

    const parts: string[] = [];

    // Inject terminal dimensions on first turn or when size changes
    const dimsChanged = !this.lastReportedDims
      || this.lastReportedDims.columns !== dims.columns
      || this.lastReportedDims.rows !== dims.rows
      || this.lastReportedDims.narrativeRows !== dims.narrativeRows;

    if (!this.dimsInjectedOnce || dimsChanged) {
      parts.push(
        `Terminal: ${dims.columns} cols × ${dims.narrativeRows} visible rows.`,
      );
      this.lastReportedDims = { ...dims };
      this.dimsInjectedOnce = true;
    }

    // Length reminder after consecutive overlong responses
    if (this.consecutiveOverlong >= LengthSteeringInjection.OVERLONG_THRESHOLD) {
      parts.push(
        `Your last ${this.consecutiveOverlong} responses exceeded one page.`
        + ` Be more concise — the player is scrolling.`,
      );
    }

    if (parts.length === 0) return null;
    return `[length] ${parts.join(" ")}`;
  }

  afterResponse(info: ResponseInfo): void {
    if (info.fromAI) return;
    const dims = this.lastReportedDims;
    if (!dims) return;
    if (info.wrappedLineCount > dims.narrativeRows) {
      this.consecutiveOverlong++;
    } else {
      this.consecutiveOverlong = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// HardStatsInjection — turn holder, combat round, resource values
// ---------------------------------------------------------------------------

/**
 * Hard numeric state that the DM tends to lose track of (HP, initiative,
 * turn holder). Emits on a fixed cadence (CADENCE turns between emissions)
 * or immediately when the rendered string changes since the last emission.
 *
 * Why not every turn? That's what we were doing via the volatile-context
 * prefix, and it was the main source of uncached input tokens — the block
 * is structurally new text every turn, so nothing in it was cache-hittable.
 * Cadence + on-change keeps the DM accurate at a fraction of the cost.
 *
 * Staleness safety: when the string does change, we emit immediately rather
 * than waiting for the cadence, so numeric drift never persists for more
 * than one turn.
 */
export class HardStatsInjection implements Injection {
  readonly name = "hard-stats";
  /** Emit at most every N turns in steady state. 2 = every-other-turn. */
  static readonly CADENCE = 2;
  private lastEmitted = "";
  private turnsSinceEmitted = Infinity; // guarantee first turn emits

  build(ctx: InjectionContext): string | null {
    if (ctx.skipTranscript) return null;
    const text = ctx.hardStatsText ?? "";
    if (!text) return null;
    const changed = text !== this.lastEmitted;
    const dueByCadence = this.turnsSinceEmitted >= HardStatsInjection.CADENCE;
    if (!changed && !dueByCadence) return null;
    this.lastEmitted = text;
    this.turnsSinceEmitted = 0;
    return `[stats]\n${text}`;
  }

  afterResponse(info: ResponseInfo): void {
    if (info.fromAI) return;
    this.turnsSinceEmitted++;
  }

  /** Reset for scene transitions so the next turn in a new scene re-emits. */
  reset(): void {
    this.lastEmitted = "";
    this.turnsSinceEmitted = Infinity;
  }
}

// ---------------------------------------------------------------------------
// InjectionRegistry — collects injections and runs them each turn
// ---------------------------------------------------------------------------

export class InjectionRegistry {
  private readonly injections: Injection[] = [];

  register(injection: Injection): void {
    this.injections.push(injection);
  }

  /** Build all injection strings for this turn. */
  buildAll(ctx: InjectionContext, devLog?: (msg: string) => void): string[] {
    const results: string[] = [];
    for (const inj of this.injections) {
      const text = inj.build(ctx);
      if (text) {
        results.push(text);
        devLog?.(`[dev] injection(${inj.name}): ${text}`);
      }
    }
    return results;
  }

  /** Notify all injections that a DM response completed. */
  afterResponse(info: ResponseInfo): void {
    for (const inj of this.injections) {
      inj.afterResponse?.(info);
    }
  }

  /** Look up a specific injection by name. */
  get<T extends Injection>(name: string): T | undefined {
    return this.injections.find((i) => i.name === name) as T | undefined;
  }
}
