/**
 * Tests for the span trace layer. These are the proof that AsyncLocalStorage
 * reconstructs the causal tree across `Promise.all` parallel dispatch and
 * nested-subagent loops — the property a flat timestamp stream can't give us.
 *
 * Spans are captured in-memory via `setTraceSink` (no disk I/O), and the id
 * counter is reset per-test so parent/child assertions are deterministic.
 */
import { withSpan, setSpanAttrs, currentSpan, resetTraceLog, setTraceSink, captureContext, runInContext } from "./trace.js";
import type { SpanRecord, TraceContext } from "./trace.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("trace", () => {
  let spans: SpanRecord[];

  beforeEach(() => {
    resetTraceLog(); // clears the sink + restarts the id counter at 0
    spans = [];
    setTraceSink((r) => spans.push(r));
  });

  afterEach(() => {
    setTraceSink(null);
  });

  it("nests parallel tools and a nested subagent under the right parents", async () => {
    // turn → agent(dm) → { tool(roll_dice), tool(search_campaign) → agent(search_campaign) → api_call }
    await withSpan({ kind: "turn", name: "turn 1", campaignId: "demo" }, async () => {
      await withSpan({ kind: "agent", name: "dm" }, async () => {
        await Promise.all([
          withSpan({ kind: "tool", name: "roll_dice" }, async () => { /* sync-ish */ }),
          withSpan({ kind: "tool", name: "search_campaign" }, async () => {
            await withSpan({ kind: "agent", name: "search_campaign" }, async () => {
              await withSpan({ kind: "api_call", name: "search_campaign" }, async () => { /* call */ });
            });
          }),
        ]);
      });
    });

    const turn = spans.find((s) => s.kind === "turn");
    const dm = spans.find((s) => s.kind === "agent" && s.name === "dm");
    const roll = spans.find((s) => s.name === "roll_dice");
    const searchTool = spans.find((s) => s.kind === "tool" && s.name === "search_campaign");
    const searchAgent = spans.find((s) => s.kind === "agent" && s.name === "search_campaign");
    const api = spans.find((s) => s.kind === "api_call");

    expect(turn).toBeDefined();
    expect(dm && roll && searchTool && searchAgent && api).toBeTruthy();

    // Root turn: no parent, turnId == its own id.
    expect(turn!.parentId).toBeNull();
    expect(turn!.turnId).toBe(turn!.id);

    // Parent linkage reconstructs the tree, including across the Promise.all.
    expect(dm!.parentId).toBe(turn!.id);
    expect(roll!.parentId).toBe(dm!.id);
    expect(searchTool!.parentId).toBe(dm!.id);
    expect(searchAgent!.parentId).toBe(searchTool!.id);  // nested subagent under its dispatching tool
    expect(api!.parentId).toBe(searchAgent!.id);

    // Every span carries the turn's turnId and the inherited campaignId.
    for (const s of [dm!, roll!, searchTool!, searchAgent!, api!]) {
      expect(s.turnId).toBe(turn!.id);
      expect(s.campaignId).toBe("demo");
    }
  });

  it("records isError and re-throws when fn throws", async () => {
    await expect(
      withSpan({ kind: "agent", name: "boom", campaignId: "x" }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    expect(spans).toHaveLength(1);
    expect(spans[0].isError).toBe(true);
    expect(spans[0].name).toBe("boom");
  });

  it("parallel branches produce overlapping intervals", async () => {
    await withSpan({ kind: "turn", name: "t", campaignId: "x" }, async () => {
      await Promise.all([
        withSpan({ kind: "tool", name: "a" }, async () => { await sleep(40); }),
        withSpan({ kind: "tool", name: "b" }, async () => { await sleep(40); }),
      ]);
    });

    const a = spans.find((s) => s.name === "a")!;
    const b = spans.find((s) => s.name === "b")!;
    // Two intervals overlap iff a.t0 < b.t1 && b.t0 < a.t1.
    expect(a.t0).toBeLessThan(b.t1);
    expect(b.t0).toBeLessThan(a.t1);
  });

  it("setSpanAttrs merges into the open span; currentSpan reflects nesting", async () => {
    expect(currentSpan()).toBeUndefined();
    await withSpan(
      { kind: "agent", name: "dm", campaignId: "x", attrs: { model: "m" } },
      async (ctx) => {
        expect(currentSpan()?.spanId).toBe(ctx.spanId);
        setSpanAttrs({ rounds: 3 });
      },
    );
    expect(currentSpan()).toBeUndefined();
    expect(spans[0].attrs).toMatchObject({ model: "m", rounds: 3 });
  });

  it("resetTraceLog restarts ids at 1 and clears the sink", async () => {
    await withSpan({ kind: "turn", name: "t1", campaignId: "x" }, async () => { /* */ });
    expect(spans[0].id).toBe(1);

    resetTraceLog(); // also clears the sink
    spans = [];
    setTraceSink((r) => spans.push(r));

    await withSpan({ kind: "turn", name: "t2", campaignId: "x" }, async () => { /* */ });
    expect(spans[0].id).toBe(1);
  });

  it("runInContext re-anchors a span to a captured context, defeating a stale ambient one", async () => {
    // Regression for the codex in-band dispatch leak: codex's persistent
    // connection invokes dispatchTool inside the ALS context captured when it
    // first opened (an early turn), so without re-anchoring every later tool
    // leaks onto that turn. captureContext()/runInContext() pin the dispatch to
    // the round that actually triggered it.
    let captured: TraceContext | undefined;
    await withSpan({ kind: "turn", name: "turn 2", campaignId: "demo" }, async () => {
      await withSpan({ kind: "agent", name: "dm" }, async () => {
        await withSpan({ kind: "api_call", name: "dm" }, async () => {
          captured = captureContext(); // turn 2's api_call context
        });
      });
    });

    // Simulate the provider firing dispatchTool from a STALE outer context
    // (an earlier turn) — re-anchored to turn 2's captured api_call.
    await withSpan({ kind: "turn", name: "turn 1 (stale)", campaignId: "demo" }, async () => {
      await runInContext(captured, async () => {
        await withSpan({ kind: "tool", name: "search_campaign" }, async () => { /* */ });
      });
    });

    const turn2 = spans.find((s) => s.kind === "turn" && s.name === "turn 2")!;
    const apiCall = spans.find((s) => s.kind === "api_call")!;
    const staleTurn = spans.find((s) => s.name === "turn 1 (stale)")!;
    const tool = spans.find((s) => s.kind === "tool" && s.name === "search_campaign")!;

    // The tool lands on turn 2's api_call (the captured context), NOT the stale
    // turn it was lexically dispatched within.
    expect(tool.parentId).toBe(apiCall.id);
    expect(tool.turnId).toBe(turn2.id);
    expect(tool.turnId).not.toBe(staleTurn.id);
  });

  it("root:true detaches from an enclosing span (own trace)", async () => {
    await withSpan({ kind: "turn", name: "turn 1", campaignId: "demo" }, async () => {
      await withSpan({ kind: "background", name: "suggested_choices", root: true }, async () => { /* */ });
    });

    const turn = spans.find((s) => s.kind === "turn")!;
    const bg = spans.find((s) => s.kind === "background")!;
    expect(bg.parentId).toBeNull();          // detached
    expect(bg.turnId).toBe(bg.id);           // seeds its own turnId
    expect(bg.turnId).not.toBe(turn.turnId);
  });
});
