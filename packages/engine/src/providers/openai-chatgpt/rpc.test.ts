import { describe, it, expect } from "vitest";
import { codexStderrLineWorthLogging, spawnFailureError } from "./rpc.js";

// codex's stderr (ANSI-stripped) is `<ts> <LEVEL> <target>: <msg>`. At
// RUST_LOG=info the INFO span records alone hit 100k+ lines/turn (measured live
// while validating #597), so we forward only WARN/ERROR + anything that isn't a
// recognizable tracing record. Samples below are verbatim shapes from a live
// run (timestamps + targets real).
describe("codexStderrLineWorthLogging", () => {
  it("keeps WARN and ERROR tracing records", () => {
    expect(codexStderrLineWorthLogging(
      "2026-06-08T19:58:31.534171Z  WARN codex_core_plugins::startup_remote_sync: startup remote plugin sync failed; will retry",
    )).toBe(true);
    expect(codexStderrLineWorthLogging(
      "2026-06-08T19:58:31.000000Z ERROR codex_core::dynamic_tools: tool call failed",
    )).toBe(true);
  });

  it("drops INFO/DEBUG/TRACE tracing records (the RUST_LOG=info firehose)", () => {
    expect(codexStderrLineWorthLogging(
      "2026-06-08T19:58:31.532719Z  INFO codex_app_server_transport::transport::remote_control: starting websocket",
    )).toBe(false);
    expect(codexStderrLineWorthLogging(
      "2026-06-08T19:58:31.534136Z  INFO app_server.request{otel.kind=\"server\" otel.name=\"initialize\"}",
    )).toBe(false);
    expect(codexStderrLineWorthLogging("2026-06-08T19:58:31.0Z DEBUG codex_core: x")).toBe(false);
    expect(codexStderrLineWorthLogging("2026-06-08T19:58:31.0Z TRACE codex_core: y")).toBe(false);
  });

  it("keeps lines that are NOT a recognizable tracing record (panics, raw output)", () => {
    // Anomalous codex output is exactly what we must not silently drop.
    expect(codexStderrLineWorthLogging("thread 'main' panicked at 'boom', src/lib.rs:42")).toBe(true);
    expect(codexStderrLineWorthLogging("   3: codex_core::run")).toBe(true);
    expect(codexStderrLineWorthLogging("some bare diagnostic with no level")).toBe(true);
  });
});

// A spawn that never starts emits `error`, not `exit`. With no `error` listener
// Node tears the whole process down, so a missing codex runtime killed Machine
// Violet outright — observed on a stock v1.1.0-rc.2 tarball, where "Sign in with
// ChatGPT" died with `spawn codex ENOENT`. These messages are what the user
// actually sees instead of a crash.
describe("spawnFailureError", () => {
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`spawn ${code}`), { code });

  it("explains an ENOENT as a missing runtime, and names the remedies", () => {
    const err = spawnFailureError("codex", errno("ENOENT"));
    expect(err.message).toMatch(/Codex runtime not installed/);
    expect(err.message).toContain("codex");
    expect(err.message).toMatch(/CODEX_BIN/);
  });

  it("distinguishes a present-but-unrunnable binary (EACCES)", () => {
    const err = spawnFailureError("/opt/mv/codex/vendor/x/bin/codex", errno("EACCES"));
    expect(err.message).toMatch(/not executable/);
    expect(err.message).toContain("/opt/mv/codex/vendor/x/bin/codex");
    expect(err.message).not.toMatch(/not installed/);
  });

  it("falls back to the underlying message for other spawn failures", () => {
    const err = spawnFailureError("codex", errno("EAGAIN"));
    expect(err.message).toMatch(/failed to start/);
    expect(err.message).toMatch(/EAGAIN/);
  });
});
