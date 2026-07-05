/**
 * Render-frequency instrument (#694 lever 2).
 *
 * React/Ink re-reconciles and repaints on every commit, and Ink diffs the WHOLE
 * output tree each time — so a component that re-renders at animation FPS drags a
 * full-screen diff along with it even when only a few cells changed. The dev-only
 * Performance Track leak (react-perf-track.ts) was one symptom of that frequency;
 * this meter measures the frequency itself so we can see what re-renders when
 * nothing visibly changed, and confirm fixes.
 *
 * Wrap regions in <RenderZone id="...">. When MV_RENDER_LOG is unset the zone is a
 * transparent passthrough with ZERO overhead (no Profiler in the tree). When set,
 * each zone's commits are counted via React.Profiler and a per-window summary is
 * appended as JSONL — flushed from a Node timer OUTSIDE React (never in the commit
 * path) so the instrument doesn't perturb what it measures.
 *
 * MV_RENDER_LOG=1        → <tmpdir>/machine-violet/render-meter.jsonl
 * MV_RENDER_LOG=<path>   → that file
 *
 * Note: React.Profiler's onRender only fires under the DEVELOPMENT reconciler
 * (npm run dev / mvplay / the harness). The shipped production build has no
 * profiler, so this is a dev/diagnostic tool — same scope as the leak it chases.
 */
import React, { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const FLUSH_MS = 2000;

/** Resolve the JSONL sink from MV_RENDER_LOG, or null when the meter is off. */
export function renderMeterLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.MV_RENDER_LOG;
  if (!v) return null;
  return /^(1|true|on|yes)$/i.test(v) ? join(tmpdir(), "machine-violet", "render-meter.jsonl") : v;
}

interface Bucket {
  commits: number;
  mounts: number;
  updates: number;
  actualMs: number;
  maxMs: number;
}
function emptyBucket(): Bucket {
  return { commits: 0, mounts: 0, updates: 0, actualMs: 0, maxMs: 0 };
}
const round = (n: number): number => Math.round(n * 100) / 100;

class RenderMeter {
  private readonly path: string | null;
  private readonly buckets = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | null = null;

  constructor(env: NodeJS.ProcessEnv) {
    this.path = renderMeterLogPath(env);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* best-effort — a missing sink just produces no log */
    }
    // Flush on a Node interval, never inside onRender: file I/O in the commit
    // path would add latency to the very renders we're trying to measure.
    // unref so the meter never keeps the process alive on its own.
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  get enabled(): boolean {
    return this.path !== null;
  }

  readonly record: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
    let b = this.buckets.get(id);
    if (!b) {
      b = emptyBucket();
      this.buckets.set(id, b);
    }
    b.commits++;
    if (phase === "mount") b.mounts++;
    else if (phase === "update") b.updates++;
    b.actualMs += actualDuration;
    if (actualDuration > b.maxMs) b.maxMs = actualDuration;
  };

  private flush(): void {
    if (!this.path) return;
    const zones: Record<string, Bucket & { perSec: number }> = {};
    for (const [id, b] of this.buckets) {
      // Always emit a line (even an all-zero window) so a truly idle stretch is
      // explicit in the log rather than indistinguishable from "not running."
      zones[id] = {
        commits: b.commits,
        mounts: b.mounts,
        updates: b.updates,
        actualMs: round(b.actualMs),
        maxMs: round(b.maxMs),
        perSec: round(b.commits / (FLUSH_MS / 1000)),
      };
      this.buckets.set(id, emptyBucket());
    }
    if (Object.keys(zones).length === 0) return; // nothing has rendered yet
    try {
      appendFileSync(this.path, JSON.stringify({ t: Date.now(), windowMs: FLUSH_MS, zones }) + "\n");
    } catch {
      /* best-effort */
    }
  }
}

const meter = new RenderMeter(process.env);

/** Whether render metering is active (MV_RENDER_LOG set). */
export function renderMeterEnabled(): boolean {
  return meter.enabled;
}

/**
 * Count commits for the wrapped subtree under `id`. Transparent passthrough (no
 * Profiler, zero cost) unless MV_RENDER_LOG is set. Nest freely — each id
 * aggregates its own subtree, so a root zone shows the total and inner zones
 * attribute it.
 */
export function RenderZone({ id, children }: { id: string; children?: ReactNode }): ReactNode {
  if (!meter.enabled) return children;
  return (
    <Profiler id={id} onRender={meter.record}>
      {children}
    </Profiler>
  );
}
