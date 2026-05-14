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
    // root. In dev/test, `process.execPath` is the user's Node binary
    // (e.g. /usr/bin/node) which has no `codex/bin/codex.js` colocated,
    // so the colocated probe naturally misses and we fall through to the
    // createRequire path which resolves `@openai/codex` from node_modules.
    // Production SEA builds hit the colocated branch instead — the
    // build-dist.js script vendors `codex/` next to the executable.
    const r = resolveCodexBinary();
    expect(["bundled", "colocated"]).toContain(r.source);
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
