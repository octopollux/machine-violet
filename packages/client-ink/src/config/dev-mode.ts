/**
 * Dev mode detection for the client.
 * Mirrors the engine's dev-mode.ts — checks DEV_MODE env var.
 */

let cached: boolean | null = null;

export function isDevMode(): boolean {
  if (cached !== null) return cached;
  cached = process.env.DEV_MODE === "true";
  return cached;
}

export function resetDevMode(): void {
  cached = null;
}
