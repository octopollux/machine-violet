import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolveCodexBinary, resetCodexBinaryCache } from "./binary.js";
import { norm } from "../../utils/paths.js";

describe("resolveCodexBinary", () => {
  let savedEnv: string | undefined;
  let savedExecPath: string;

  beforeEach(() => {
    resetCodexBinaryCache();
    savedEnv = process.env.CODEX_BIN;
    delete process.env.CODEX_BIN;
    savedExecPath = process.execPath;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = savedEnv;
    process.execPath = savedExecPath;
    resetCodexBinaryCache();
  });

  it("returns the bundled @openai/codex bin via Node when available", () => {
    // The bundled package is a workspace dependency installed at the repo
    // root. In dev/test, `process.execPath` is the user's Node binary
    // (e.g. /usr/bin/node) which has no `codex/vendor/...` tree colocated,
    // so the colocated probe naturally misses and we fall through to the
    // createRequire path which resolves `@openai/codex` from node_modules.
    // Production SEA builds hit the colocated branch instead and spawn
    // the native binary directly (see binary.ts).
    const r = resolveCodexBinary();
    if (r.source === "bundled") {
      expect(r.path).toBe(process.execPath);
      expect(r.prefixArgs).toHaveLength(1);
      expect(r.prefixArgs[0]).toMatch(/codex.*\.js$/);
    } else {
      // colocated — native binary, no script wrapper
      expect(r.source).toBe("colocated");
      expect(r.prefixArgs).toHaveLength(0);
      expect(r.path).toMatch(/codex(?:\.exe)?$/);
    }
  });

  it("caches the resolution across calls", () => {
    const a = resolveCodexBinary();
    const b = resolveCodexBinary();
    expect(a).toBe(b);
  });

  it("resolves colocated native binary when SEA-style layout sits next to execPath", () => {
    // Simulate the production SEA layout that build-dist.js produces, mirroring
    // the real `@openai/codex` vendor tree (see the node_modules guard below):
    //   <exeDir>/MachineViolet[.exe]
    //   <exeDir>/codex/vendor/<triple>/bin/codex[.exe]
    //   <exeDir>/codex/vendor/<triple>/codex-path/          (for bundled rg)
    // The resolver should pick the native binary directly (no script wrapper,
    // prefixArgs empty), point CODEX_MANAGED_PACKAGE_ROOT at the colocated
    // codex/ root, and prepend the codex-path/ dir to PATH. Getting the subdir
    // names wrong is exactly the #719 crash: resolution silently misses and
    // falls through to the bare-`codex` PATH lookup.
    const root = mkdtempSync(join(tmpdir(), "mv-codex-test-"));
    try {
      const triple = "x86_64-pc-windows-msvc";
      const exeName = process.platform === "win32" ? "codex.exe" : "codex";
      const codexRoot = join(root, "codex");
      const archDir = join(codexRoot, "vendor", triple);
      const binDir = join(archDir, "bin");
      const pathDir = join(archDir, "codex-path");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(join(binDir, exeName), "");

      process.execPath = join(root, process.platform === "win32" ? "MachineViolet.exe" : "MachineViolet");
      resetCodexBinaryCache();

      const r = resolveCodexBinary();
      expect(r.source).toBe("colocated");
      expect(r.prefixArgs).toEqual([]);
      expect(norm(r.path)).toBe(norm(join(binDir, exeName)));
      expect(norm(r.extraEnv?.CODEX_MANAGED_PACKAGE_ROOT ?? "")).toBe(norm(codexRoot));
      expect(r.extraEnv?.PATH).toBeDefined();
      expect(r.extraEnv!.PATH.split(delimiter)[0]).toBe(pathDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits PATH augmentation when colocated layout has no sibling codex-path/ dir", () => {
    // Defensive: an upstream codex release that ever drops the ripgrep
    // sidecar would still resolve, just without PATH augmentation.
    // CODEX_MANAGED_PACKAGE_ROOT is still set so the native binary can find
    // whatever else lives under the package root.
    const root = mkdtempSync(join(tmpdir(), "mv-codex-test-"));
    try {
      const triple = "x86_64-pc-windows-msvc";
      const exeName = process.platform === "win32" ? "codex.exe" : "codex";
      const binDir = join(root, "codex", "vendor", triple, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, exeName), "");

      process.execPath = join(root, process.platform === "win32" ? "MachineViolet.exe" : "MachineViolet");
      resetCodexBinaryCache();

      const r = resolveCodexBinary();
      expect(r.source).toBe("colocated");
      expect(r.extraEnv?.PATH).toBeUndefined();
      expect(r.extraEnv?.CODEX_MANAGED_PACKAGE_ROOT).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("colocated subdir names match the real @openai/codex vendor layout", () => {
    // Regression guard for #719: the fixtures above (and binary.ts's colocated
    // resolution) hardcode the `bin/` + `codex-path/` subdir names. The
    // colocated path has NO live CI coverage — the packaged-artifact replay
    // gate runs against recorded tapes, never spawning a real codex — so if a
    // future `@openai/codex` bump renames those dirs, nothing else catches it
    // until a user's install crashes with `'codex' is not recognized`. Assert
    // the names against the actual installed package so the drift fails here,
    // at build time, instead of in the field.
    const require_ = createRequire(import.meta.url);
    let platformRoot: string;
    try {
      // The platform binary package the wrapper depends on for this host.
      const map: Record<string, string> = {
        "win32:x64": "@openai/codex-win32-x64",
        "win32:arm64": "@openai/codex-win32-arm64",
        "darwin:x64": "@openai/codex-darwin-x64",
        "darwin:arm64": "@openai/codex-darwin-arm64",
        "linux:x64": "@openai/codex-linux-x64",
        "linux:arm64": "@openai/codex-linux-arm64",
      };
      const pkg = map[`${process.platform}:${process.arch}`];
      if (!pkg) return; // unsupported host — nothing to assert
      platformRoot = dirname(require_.resolve(`${pkg}/package.json`));
    } catch {
      return; // optional platform dep not installed in this env — skip
    }

    const tripleMap: Record<string, string> = {
      "win32:x64": "x86_64-pc-windows-msvc",
      "win32:arm64": "aarch64-pc-windows-msvc",
      "darwin:x64": "x86_64-apple-darwin",
      "darwin:arm64": "aarch64-apple-darwin",
      "linux:x64": "x86_64-unknown-linux-musl",
      "linux:arm64": "aarch64-unknown-linux-musl",
    };
    const triple = tripleMap[`${process.platform}:${process.arch}`];
    const exeName = process.platform === "win32" ? "codex.exe" : "codex";
    const archDir = join(platformRoot, "vendor", triple);
    // The two subdir names binary.ts depends on must exist in the real tree.
    expect(existsSync(join(archDir, "bin", exeName))).toBe(true);
    expect(existsSync(join(archDir, "codex-path"))).toBe(true);
  });
});
