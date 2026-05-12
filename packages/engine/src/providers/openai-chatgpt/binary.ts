/**
 * Resolve the `codex` binary path.
 *
 * Look up order:
 *   1. The `@openai/codex` npm package bundled with the engine (vendored
 *      into the SEA build's node_modules) — preferred, version-pinned.
 *   2. `process.env.CODEX_BIN` override — for local dev or experiments.
 *   3. PATH lookup — fallback for environments where the user installed
 *      Codex globally themselves.
 *
 * If none resolves, callers will get a spawn EAGAIN/ENOENT and surface a
 * "Codex runtime not installed" error to the user. The Connections UI
 * exposes an explicit install action that runs `npm i @openai/codex` into
 * the user's app config dir as a recovery path.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

let cached: CodexBinaryResolution | null = null;

export interface CodexBinaryResolution {
  /** Executable to spawn. */
  path: string;
  /** Arguments to prepend (e.g. ["bin/codex.js"] when path is "node"). */
  prefixArgs: string[];
  source: "bundled" | "env" | "path";
}

/**
 * Returns the resolved binary path + source. Throws if no candidate exists.
 *
 * Caches the result for the process lifetime — the binary location does not
 * change at runtime and the resolution does a few stat() calls we'd rather
 * not repeat.
 */
export function resolveCodexBinary(): CodexBinaryResolution {
  if (cached) return cached;

  // 1. Bundled package — `@openai/codex` ships `bin/codex.js` as a
  // shebang Node script. On Windows there's no shebang interpretation,
  // and even on Linux/macOS we can't rely on the file being executable
  // out of the npm cache. So we invoke it via the current Node binary
  // explicitly: `process.execPath bin/codex.js app-server ...`.
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("@openai/codex/package.json");
    const pkgRoot = dirname(pkgJsonPath);
    const jsEntry = join(pkgRoot, "bin", "codex.js");
    if (existsSync(jsEntry)) {
      cached = { path: process.execPath, prefixArgs: [jsEntry], source: "bundled" };
      return cached;
    }
  } catch {
    // package not installed — fall through
  }

  // 2. Env override — accept either a node-script path or a native binary.
  // If the path ends in .js we run it via Node; otherwise spawn directly.
  const envBin = process.env.CODEX_BIN;
  if (envBin && existsSync(envBin)) {
    cached = envBin.endsWith(".js")
      ? { path: process.execPath, prefixArgs: [envBin], source: "env" }
      : { path: envBin, prefixArgs: [], source: "env" };
    return cached;
  }

  // 3. PATH lookup — let the OS resolve. Globally-installed `codex` from
  // `npm i -g @openai/codex` lands as a `.cmd` shim on Windows and a
  // shell wrapper on Linux/macOS; both handle Node invocation themselves.
  cached = { path: "codex", prefixArgs: [], source: "path" };
  return cached;
}

/** Reset the resolution cache (for tests). */
export function resetCodexBinaryCache(): void {
  cached = null;
}
