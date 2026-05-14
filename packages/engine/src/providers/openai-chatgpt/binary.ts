/**
 * Resolve the `codex` binary path.
 *
 * Look up order:
 *   1. Colocated with the running executable: `<exeDir>/codex/bin/codex.js`
 *      with vendor binaries at `<exeDir>/codex/vendor/{triple}/...`. This is
 *      what production builds ship — see `scripts/build-dist.js`, which
 *      copies the platform-matching codex tree out of node_modules into
 *      `dist/codex/` next to the SEA executable. The codex.js wrapper's
 *      own fallback path (`../vendor/...` relative to bin/codex.js) finds
 *      the native binary without needing a sibling optional-dep package.
 *   2. The `@openai/codex` npm package resolved via `createRequire` —
 *      this is the path for `npm run dev` and tests, where node_modules
 *      lives next to the source.
 *   3. `process.env.CODEX_BIN` override — for local dev or experiments
 *      (accepts a `.js` script or a native exe).
 *   4. PATH lookup — fallback for environments where the user installed
 *      Codex globally themselves (`npm i -g @openai/codex`).
 *
 * If none resolves, callers will get a spawn EAGAIN/ENOENT and surface a
 * "Codex runtime not installed" error to the user.
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
  source: "colocated" | "bundled" | "env" | "path";
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

  // 1. Colocated with the running executable — production SEA builds ship
  // `dist/codex/bin/codex.js` + `dist/codex/vendor/{triple}/...` next to
  // MachineViolet[.exe]. We run codex.js through Node (the SEA process
  // itself) so we don't need a separate Node install. codex.js's own
  // bootstrap looks for `../vendor/...` next to itself and finds the
  // native Rust binary without requiring sibling node_modules.
  //
  // In dev mode, `process.execPath` is the user's Node binary (e.g.
  // /usr/bin/node) and the colocated probe naturally misses, falling
  // through to the createRequire path.
  try {
    const exeDir = dirname(process.execPath);
    const colocated = join(exeDir, "codex", "bin", "codex.js");
    if (existsSync(colocated)) {
      cached = { path: process.execPath, prefixArgs: [colocated], source: "colocated" };
      return cached;
    }
  } catch { /* fall through */ }

  // 2. Bundled package — `@openai/codex` ships `bin/codex.js` as a
  // shebang Node script. On Windows there's no shebang interpretation,
  // and even on Linux/macOS we can't rely on the file being executable
  // out of the npm cache. So we invoke it via the current Node binary
  // explicitly: `process.execPath bin/codex.js app-server ...`. This
  // path is used by `npm run dev` and tests (production uses #1).
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

  // 3. Env override — accept either a node-script path or a native binary.
  // If the path ends in .js we run it via Node; otherwise spawn directly.
  const envBin = process.env.CODEX_BIN;
  if (envBin && existsSync(envBin)) {
    cached = envBin.endsWith(".js")
      ? { path: process.execPath, prefixArgs: [envBin], source: "env" }
      : { path: envBin, prefixArgs: [], source: "env" };
    return cached;
  }

  // 4. PATH lookup — let the OS resolve. Globally-installed `codex` from
  // `npm i -g @openai/codex` lands as a `.cmd` shim on Windows and a
  // shell wrapper on Linux/macOS; both handle Node invocation themselves.
  cached = { path: "codex", prefixArgs: [], source: "path" };
  return cached;
}

/** Reset the resolution cache (for tests). */
export function resetCodexBinaryCache(): void {
  cached = null;
}
