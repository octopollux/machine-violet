/**
 * Build-time version constants.
 *
 * Injected by scripts/build-dist.js via esbuild `define`. In dev (no bundling),
 * these env vars are unset and we fall back to "dev" / null.
 */

export const APP_VERSION: string =
  (typeof process.env.MV_VERSION === "string" && process.env.MV_VERSION) || "dev";

/** UTC release timestamp baked at build time, e.g. "2026-04-13 18:32". Null in dev. */
export const RELEASE_DATE: string | null =
  typeof process.env.MV_RELEASE_DATE === "string" && process.env.MV_RELEASE_DATE
    ? process.env.MV_RELEASE_DATE
    : null;
