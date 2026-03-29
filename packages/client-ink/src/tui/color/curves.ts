/**
 * Composable curve functions for parameterising OKLCH swatch generation.
 * Each CurveFunction maps t ∈ [0, 1] → [0, 1] (or any useful range).
 */

/** A function mapping normalized position t ∈ [0,1] to a parameter value. */
export type CurveFunction = (t: number) => number;

/** Always returns the same value. */
export function constant(v: number): CurveFunction {
  return () => v;
}

/** Linear interpolation from a to b. */
export function linearRamp(a: number, b: number): CurveFunction {
  return (t) => a + (b - a) * t;
}

/** Sine pulse: oscillates around base with given amplitude. */
export function sinePulse(base: number, amp: number): CurveFunction {
  return (t) => base + amp * Math.sin(t * Math.PI);
}

/** Smooth ease-in-out (cubic Hermite) from a to b. */
export function easeInOut(a: number, b: number): CurveFunction {
  return (t) => {
    const s = t * t * (3 - 2 * t); // smoothstep
    return a + (b - a) * s;
  };
}

/** Bell curve centered at `center` with given `width` (σ-like), peak = 1. */
export function bell(center: number, width: number): CurveFunction {
  return (t) => Math.exp(-((t - center) ** 2) / (2 * width * width));
}

/** Compose: outer(inner(t)). */
export function compose(outer: CurveFunction, inner: CurveFunction): CurveFunction {
  return (t) => outer(inner(t));
}
