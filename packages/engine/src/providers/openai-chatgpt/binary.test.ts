import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
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
    // Simulate the production SEA layout that build-dist.js produces:
    //   <exeDir>/MachineViolet[.exe]
    //   <exeDir>/codex/vendor/<triple>/codex/codex[.exe]
    //   <exeDir>/codex/vendor/<triple>/path/             (for bundled rg)
    // The resolver should pick the native binary directly (no script
    // wrapper, prefixArgs empty) and prepend the path/ dir to PATH so
    // the bundled `rg` is discoverable.
    const root = mkdtempSync(join(tmpdir(), "mv-codex-test-"));
    try {
      const triple = "x86_64-pc-windows-msvc";
      const exeName = process.platform === "win32" ? "codex.exe" : "codex";
      const archDir = join(root, "codex", "vendor", triple);
      const codexDir = join(archDir, "codex");
      const pathDir = join(archDir, "path");
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(pathDir, { recursive: true });
      writeFileSync(join(codexDir, exeName), "");

      process.execPath = join(root, process.platform === "win32" ? "MachineViolet.exe" : "MachineViolet");
      resetCodexBinaryCache();

      const r = resolveCodexBinary();
      expect(r.source).toBe("colocated");
      expect(r.prefixArgs).toEqual([]);
      expect(norm(r.path)).toBe(norm(join(codexDir, exeName)));
      expect(r.extraEnv?.PATH).toBeDefined();
      expect(r.extraEnv!.PATH.split(delimiter)[0]).toBe(pathDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits PATH augmentation when colocated layout has no sibling path/ dir", () => {
    // Defensive: an upstream codex release that ever drops the ripgrep
    // sidecar would still resolve, just without PATH augmentation.
    const root = mkdtempSync(join(tmpdir(), "mv-codex-test-"));
    try {
      const triple = "x86_64-pc-windows-msvc";
      const exeName = process.platform === "win32" ? "codex.exe" : "codex";
      const codexDir = join(root, "codex", "vendor", triple, "codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, exeName), "");

      process.execPath = join(root, process.platform === "win32" ? "MachineViolet.exe" : "MachineViolet");
      resetCodexBinaryCache();

      const r = resolveCodexBinary();
      expect(r.source).toBe("colocated");
      expect(r.extraEnv?.PATH).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
