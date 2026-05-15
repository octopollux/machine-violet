/**
 * Resolve the `codex` binary path.
 *
 * Look up order:
 *   1. Colocated with the running executable: `<exeDir>/codex/vendor/{triple}/codex/codex[.exe]`,
 *      vendored next to the SEA binary by `scripts/build-dist.js`. We spawn
 *      the native Rust binary directly — NOT the `codex.js` wrapper —
 *      because `process.execPath` in a Node SEA build is the SEA exe itself
 *      (e.g. `MachineViolet.exe`), not a real `node` interpreter. A SEA
 *      binary ignores its first script-path argv and always runs its
 *      embedded main, so `MachineViolet.exe codex/bin/codex.js app-server`
 *      would relaunch Machine Violet instead of running Codex.
 *      We also prepend `vendor/{triple}/path` to PATH so the bundled
 *      `rg.exe` is discoverable — that's what codex.js does too.
 *   2. The `@openai/codex` npm package resolved via `createRequire` —
 *      this is the path for `npm run dev` and tests, where node_modules
 *      lives next to the source and `process.execPath` IS real Node, so
 *      running codex.js through it works.
 *   3. `process.env.CODEX_BIN` override — for local dev or experiments
 *      (accepts a `.js` script or a native exe).
 *   4. PATH lookup — fallback for environments where the user installed
 *      Codex globally themselves (`npm i -g @openai/codex`).
 *
 * If none resolves, callers will get a spawn EAGAIN/ENOENT and surface a
 * "Codex runtime not installed" error to the user.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";

let cached: CodexBinaryResolution | null = null;

export interface CodexBinaryResolution {
  /** Executable to spawn. */
  path: string;
  /** Arguments to prepend (e.g. ["bin/codex.js"] when path is "node"). */
  prefixArgs: string[];
  /** Extra env vars to merge into the spawned child's environment (e.g. PATH augmentation for bundled `rg`). */
  extraEnv?: Record<string, string>;
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
  // `dist/codex/vendor/{triple}/codex/codex[.exe]` next to MachineViolet[.exe].
  // We spawn the native Rust binary directly; running codex.js through
  // `process.execPath` would actually relaunch the SEA exe itself (the SEA
  // ignores script-path argv and always runs its embedded main).
  try {
    const exeDir = dirname(process.execPath);
    const codexRoot = join(exeDir, "codex");
    const vendorDir = join(codexRoot, "vendor");
    if (existsSync(vendorDir)) {
      // Each build vendors exactly one platform triple's subdir. Just take
      // whatever's there rather than re-deriving the platform mapping.
      const triples = readdirSync(vendorDir).filter((d) =>
        statSync(join(vendorDir, d)).isDirectory(),
      );
      if (triples.length > 0) {
        const triple = triples[0];
        const exeName = process.platform === "win32" ? "codex.exe" : "codex";
        const nativeBin = join(vendorDir, triple, "codex", exeName);
        if (existsSync(nativeBin)) {
          // Prepend the sibling `path/` dir to PATH so codex can find its
          // bundled ripgrep, matching what codex.js does itself.
          const pathDir = join(vendorDir, triple, "path");
          const extraEnv: Record<string, string> = {};
          if (existsSync(pathDir)) {
            extraEnv.PATH = pathDir + delimiter + (process.env.PATH ?? "");
          }
          cached = {
            path: nativeBin,
            prefixArgs: [],
            extraEnv,
            source: "colocated",
          };
          return cached;
        }
      }
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
