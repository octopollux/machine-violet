import Fastify, { type FastifyInstance } from "fastify";
import { vi, beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { Tape } from "../../providers/tape.js";

// The route's only logic is "404 when not recording, else return the tape
// verbatim." getRecordedTape() itself is unit-tested in tape-mode.test.ts, so
// here we mock it and assert the wiring + that the deep tape survives
// serialization (no response schema dropping fields).
vi.mock("../../providers/tape-mode.js", () => ({ getRecordedTape: vi.fn() }));
import { getRecordedTape } from "../../providers/tape-mode.js";
import { devRoutes } from "./dev.js";

const mockGetTape = vi.mocked(getRecordedTape);

async function buildApp() {
  const app = Fastify();
  await app.register(devRoutes);
  await app.ready();
  return app;
}

describe("GET /tape", () => {
  let app: FastifyInstance;

  // Build the Fastify app once for the file. Construction (register + ready +
  // route/serializer setup) is the only heavy step here (~150ms cold); under
  // full-suite fork-pool CPU contention it can stretch past the 5s default,
  // which is what made this test flaky when buildApp() ran inside the timed
  // `it` body. Isolating construction in beforeAll with explicit headroom keeps
  // it off the per-test budget (matching server.test.ts) — the route is
  // stateless and reads the mocked getRecordedTape() fresh per request, so one
  // shared app is safe — and leaves the assertions on the tight default timeout
  // so a genuine route hang still surfaces fast.
  beforeAll(async () => {
    app = await buildApp();
  }, 20000);

  afterAll(async () => {
    // Guard: if beforeAll's construction threw/timed out, `app` is undefined —
    // an unconditional close() would throw a secondary error that buries the
    // real setup failure (the very failure mode this test guards against).
    await app?.close();
  });

  beforeEach(() => {
    mockGetTape.mockReset();
  });

  it("404s when the process isn't recording", async () => {
    mockGetTape.mockReturnValue(null);
    const res = await app.inject({ method: "GET", url: "/tape" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
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
    const res = await app.inject({ method: "GET", url: "/tape" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(tape);
  });
});
