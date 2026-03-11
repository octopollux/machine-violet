/**
 * Batches rapid narrative line updates into throttled state flushes.
 *
 * During streaming, appendDelta fires per-token (often 1-3 chars each).
 * Without batching, every delta triggers a React state update → full
 * component tree re-render.  This hook accumulates deltas in a ref and
 * flushes to real React state on a timer, cutting re-renders by ~10-20×.
 *
 * Non-delta updates (player lines, system messages) flush immediately
 * so the UI never feels laggy for discrete events.
 *
 * GC optimization: functional updaters (the streaming hot path) are
 * applied eagerly against a mutable working copy in the ref, so only
 * one array snapshot is created per flush instead of one per token.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import type { NarrativeLine } from "../../types/tui.js";

/** Default flush interval in ms — ~16ms ≈ 60 fps ceiling. */
const FLUSH_INTERVAL_MS = 16;

export interface BatchedNarrativeLines {
  /** The current lines for rendering (updated on flush). */
  lines: NarrativeLine[];
  /** Drop-in replacement for setNarrativeLines.  Immediate updates flush
   *  synchronously; streaming-style functional updates are batched. */
  setLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>>;
}

export function useBatchedNarrativeLines(
  flushInterval = FLUSH_INTERVAL_MS,
): BatchedNarrativeLines {
  const [lines, setLinesReal] = useState<NarrativeLine[]>([]);

  // Mutable working copy that functional updaters are applied to eagerly.
  // Between flushes, this accumulates all mutations without creating
  // intermediate array copies — each appendDelta mutates in-place.
  const workingRef = useRef<NarrativeLine[]>(lines);
  // Whether the working copy has been modified since the last flush.
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest committed value (for direct-set path).
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Flush: snapshot the working copy into React state.
  const flush = useCallback(() => {
    timerRef.current = null;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    // Snapshot: create an immutable copy for React.
    const snapshot = [...workingRef.current];
    setLinesReal(snapshot);
  }, []);

  // Stable setter that batches functional updates and flushes direct sets.
  const setLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>> = useCallback(
    (action) => {
      if (typeof action === "function") {
        // Functional update (streaming delta) — apply eagerly to working copy.
        // The updater (e.g. appendDelta) returns a new array, but we only keep
        // the latest result — no intermediate snapshots are retained.
        workingRef.current = action(workingRef.current);
        dirtyRef.current = true;
        if (timerRef.current === null) {
          timerRef.current = setTimeout(flush, flushInterval);
        }
      } else {
        // Direct set (e.g. full replacement) — flush immediately.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        dirtyRef.current = false;
        workingRef.current = action;
        setLinesReal(action);
      }
    },
    [flush, flushInterval],
  );

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { lines, setLines };
}
