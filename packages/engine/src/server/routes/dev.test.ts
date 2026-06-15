import Fastify from "fastify";
import { vi, beforeEach, describe, it, expect } from "vitest";
import type { Tape } from "../../providers/tape.js";

// The route's only logic is "404 when not recording, else return the tape
// verbatim." getRecordedTape() itself is unit-tested in tape-mode.test.ts, so
// here we mock it and assert the wiring + that the deep tape survives
// serialization (no response schema dropping fields).
vi.mock("../../providers/tape-mode.js", () => ({ getRecordedTape: vi.fn() }));
import { getRecordedTape } from "../../providers/tape-mode.js";
import { devRoutes } from "./dev.js";

const mockGetTape = vi.mocked(getRecordedTape);

// These tests are logically instant (in-process Fastify `inject`, no network),
// but Fastify boot can blow the 5s default under heavy parallel-suite CPU
// contention (multiple agents/tsc share this machine — see CLAUDE.md). Give
// generous headroom so a starved event loop never reds the nightly; a genuine
// hang still trips this ceiling.
vi.setConfig({ testTimeout: 30_000 });

async function buildApp() {
  const app = Fastify();
  await app.register(devRoutes);
  await app.ready();
  return app;
}

describe("GET /tape", () => {
  beforeEach(() => {
    mockGetTape.mockReset();
  });

  it("404s when the process isn't recording", async () => {
    mockGetTape.mockReturnValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tape" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });

  it("returns the recorded tape verbatim (deep fields survive)", async () => {
    const tape: Tape = {
      version: 1,
      scenario: "demo",
      capabilities: { "claude-haiku-4-5-20251001": { maxTokens: 8192 } as never },
      entries: [
        {
          kind: "chat",
          bucket: "dm",
          ordinal: 0,
          request: { model: "m", messageCount: 1, systemHash: "abc", tools: ["roll_dice"], lastMessagePreview: "hi" },
          result: { text: "You open the door.", toolUses: [], stopReason: "end_turn" } as never,
        },
      ],
    };
    mockGetTape.mockReturnValue(tape);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/tape" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(tape);
    await app.close();
  });
});
