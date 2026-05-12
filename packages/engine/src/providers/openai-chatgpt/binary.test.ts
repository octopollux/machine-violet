import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveCodexBinary, resetCodexBinaryCache } from "./binary.js";

describe("resolveCodexBinary", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    resetCodexBinaryCache();
    savedEnv = process.env.CODEX_BIN;
    delete process.env.CODEX_BIN;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = savedEnv;
    resetCodexBinaryCache();
  });

  it("returns the bundled @openai/codex bin via Node when available", () => {
    // The bundled package is a workspace dependency installed at the repo
    // root. resolveCodexBinary should pick up bin/codex.js and return a
    // {path: process.execPath, prefixArgs: [<jsEntry>], source: 'bundled'}
    // resolution. If the dep is missing for some reason (e.g. lockfile
    // change), the fallback is path-resolution which we don't want to
    // exercise in this test.
    const r = resolveCodexBinary();
    expect(r.source).toBe("bundled");
    expect(r.path).toBe(process.execPath);
    expect(r.prefixArgs).toHaveLength(1);
    expect(r.prefixArgs[0]).toMatch(/codex.*\.js$/);
  });

  it("caches the resolution across calls", () => {
    const a = resolveCodexBinary();
    const b = resolveCodexBinary();
    expect(a).toBe(b);
  });
});
