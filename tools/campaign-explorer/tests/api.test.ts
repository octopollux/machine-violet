/**
 * Tests for the engine-log tail helper that backs both the /engine-log/api-calls
 * and the new /engine-log/spans endpoints. Exercises the shared predicate-based
 * tail: campaign/kind filtering for spans, event/agent filtering for api-calls
 * (a regression guard for the refactor from the old api-call-only tail), and
 * the bounded "last N" behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tailJsonlEvents } from "../src/server/api.js";

describe("tailJsonlEvents", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mv-explorer-test-"));
    logPath = join(dir, "log.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeLines(lines: object[], extra: string[] = []): void {
    const body = lines.map((l) => JSON.stringify(l)).concat(extra).join("\n") + "\n";
    writeFileSync(logPath, body);
  }

  it("filters spans by campaignId and ignores non-span / malformed lines", async () => {
    writeLines(
      [
        { id: 1, kind: "turn", name: "turn 1", campaignId: "alpha", t0: 1, t1: 5, durMs: 4 },
        { id: 2, kind: "agent", name: "dm", campaignId: "alpha", t0: 1, t1: 4, durMs: 3 },
        { id: 9, kind: "turn", name: "turn 1", campaignId: "beta", t0: 1, t1: 9, durMs: 8 },
        { event: "api:call", agent: "dm", durationMs: 100 }, // engine.jsonl event — no `kind`
      ],
      ["", "not json at all", "{ partial"],
    );

    const spans = await tailJsonlEvents(
      logPath,
      5000,
      (o) => typeof o.kind === "string" && o.campaignId === "alpha",
    );

    expect(spans.map((s) => s.id)).toEqual([1, 2]);
    expect(spans.every((s) => s.campaignId === "alpha")).toBe(true);
  });

  it("filters api:call events by event type and agent", async () => {
    writeLines([
      { event: "api:call", agent: "dm", durationMs: 100 },
      { event: "api:call", agent: "scribe", durationMs: 50 },
      { event: "turn:dm_complete", durationMs: 200 },
      { id: 1, kind: "turn", campaignId: "alpha" }, // a span — must be ignored here
    ]);

    const dmCalls = await tailJsonlEvents(
      logPath,
      500,
      (o) => o.event === "api:call" && o.agent === "dm",
    );
    expect(dmCalls).toHaveLength(1);
    expect(dmCalls[0].agent).toBe("dm");

    const allCalls = await tailJsonlEvents(logPath, 500, (o) => o.event === "api:call");
    expect(allCalls).toHaveLength(2);
  });

  it("returns only the last `limit` matching records", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      kind: "tool",
      name: `tool-${i}`,
      campaignId: "alpha",
    }));
    writeLines(lines);

    const last10 = await tailJsonlEvents(logPath, 10, (o) => typeof o.kind === "string");
    expect(last10).toHaveLength(10);
    expect(last10.map((s) => s.id)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
  });

  it("returns [] for a missing file via the caller's try/catch contract", async () => {
    // tailJsonlEvents throws on a missing path (ENOENT from the read stream);
    // the route wraps it in try/catch and responds []. Assert the throw so the
    // contract the endpoints rely on is explicit.
    await expect(
      tailJsonlEvents(join(dir, "does-not-exist.jsonl"), 10, () => true),
    ).rejects.toBeTruthy();
  });
});
