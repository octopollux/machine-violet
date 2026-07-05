/**
 * React dev "Performance Track" suppression (#694).
 *
 * react-reconciler's DEVELOPMENT build — the one loaded whenever NODE_ENV !==
 * "production" (i.e. `npm run dev`, mvplay, the golden harness) — emits a
 * `performance.measure()` per component render to feed React DevTools' component
 * Performance Track. Node retains every User Timing entry forever and nothing in
 * this terminal app reads them, so a long session's continuous re-renders fill an
 * unbounded buffer and OOM the launcher (~14 MB/min even at an idle menu).
 *
 * React gates the ENTIRE track on a capability probe captured ONCE when
 * react-reconciler first evaluates: `typeof console.timeStamp === "function"`. In
 * a plain Node process (no inspector) `console.timeStamp` is a meaningless no-op
 * that React nonetheless reads as "profiling wanted." Clearing it BEFORE the
 * reconciler is imported disables the emission at the source — no measures, no
 * buffer growth, none of the per-render arg-building churn.
 *
 * This is a zero-import leaf on purpose: the launcher imports it statically and
 * calls it before the client (and its Ink/react-reconciler graph) is dynamically
 * imported, so importing this must not pull in Ink.
 */

const TRUTHY = /^(1|true|on|yes)$/i;

/** Whether the caller opted IN to keeping React's dev Performance Track (for profiling). */
export function shouldKeepReactPerfTrack(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.test(env.MV_REACT_PERF_TRACK ?? "");
}

/**
 * Neutralize the `console.timeStamp` probe React reads at reconciler module-eval,
 * unless profiling was explicitly requested via `MV_REACT_PERF_TRACK`. MUST run
 * before react-reconciler is first imported. Returns true if the track was
 * disabled, false if left on (opt-in).
 */
export function disableReactPerfTrackUnlessRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  if (shouldKeepReactPerfTrack(env)) return false;
  (console as { timeStamp?: (label?: string) => void }).timeStamp = undefined;
  return true;
}
