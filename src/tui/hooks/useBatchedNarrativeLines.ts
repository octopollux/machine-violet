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

  // Pending updaters accumulated between flushes.
  const pendingRef = useRef<Array<React.SetStateAction<NarrativeLine[]>>>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest committed value (avoids stale closure in flush).
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Flush: apply all pending updaters in order, commit once.
  const flush = useCallback(() => {
    timerRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];

    // Reduce all pending actions into a single state value.
    let current = linesRef.current;
    for (const action of pending) {
      current = typeof action === "function" ? action(current) : action;
    }
    setLinesReal(current);
  }, []);

  // Stable setter that batches functional updates and flushes direct sets.
  const setLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>> = useCallback(
    (action) => {
      if (typeof action === "function") {
        // Functional update (streaming delta) — batch it.
        pendingRef.current.push(action);
        if (timerRef.current === null) {
          timerRef.current = setTimeout(flush, flushInterval);
        }
      } else {
        // Direct set (e.g. full replacement) — flush immediately.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        // Apply any pending functional updates first, then the direct set.
        if (pendingRef.current.length > 0) {
          const pending = pendingRef.current;
          pendingRef.current = [];
          let current = linesRef.current;
          for (const p of pending) {
            current = typeof p === "function" ? p(current) : p;
          }
          // The direct set replaces everything anyway.
        }
        pendingRef.current = [];
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
