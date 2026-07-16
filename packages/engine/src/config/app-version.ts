/**
 * Resolve the application version for `--version`.
 *
 * Two sources, depending on how we're running:
 *  - Compiled (SEA): `version.json`, written next to the executable by
 *    `scripts/build-dist.js` (`{ version, releaseDate }`).
 *  - Dev: the monorepo root `package.json`.
 *
 * Never throws — `--version` must not be the thing that crashes. An
 * unreadable/absent file yields {@link UNKNOWN_VERSION} so callers still print
 * something useful.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiled } from "../utils/paths.js";

export const UNKNOWN_VERSION = "unknown";

export interface VersionSources {
  /** Override compiled-vs-dev detection (tests). */
  compiled?: boolean;
  /** Override `process.execPath` (tests). */
  execPath?: string;
  /** Override the dev monorepo root (tests). */
  repoRoot?: string;
  /** Override the file reader (tests). */
  readFile?: (path: string) => string;
}

/**
 * The file that carries the version, for the current run mode.
 *
 * Compiled builds ship `version.json` beside the exe. In dev there is no
 * `version.json` (it's a build artifact), so we read the monorepo root
 * package.json — the same value `build-dist.js` stamps into version.json.
 */
export function versionFile(src: VersionSources = {}): string {
  const compiled = src.compiled ?? isCompiled();
  if (compiled) {
    return join(dirname(src.execPath ?? process.execPath), "version.json");
  }
  // src/config/app-version.ts → packages/engine/src/config → repo root is ../../../..
  const root = src.repoRoot ?? join(import.meta.dirname, "..", "..", "..", "..");
  return join(root, "package.json");
}

/** The app version, or {@link UNKNOWN_VERSION} if it can't be determined. */
export function readAppVersion(src: VersionSources = {}): string {
  const read = src.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  try {
    const parsed: unknown = JSON.parse(read(versionFile(src)));
    if (parsed && typeof parsed === "object") {
      const { version } = parsed as { version?: unknown };
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Missing, unreadable, or malformed — fall through.
  }
  return UNKNOWN_VERSION;
}

/**
 * The one-line `--version` banner.
 *
 * The product name is load-bearing, not decoration: the Homebrew formula's
 * `test do` block asserts the output matches "MachineViolet", and install.sh
 * echoes this string as its post-install confirmation.
 */
export function versionBanner(src: VersionSources = {}): string {
  return `MachineViolet ${readAppVersion(src)}`;
}
