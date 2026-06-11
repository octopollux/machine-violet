import { DeferredWork } from "./deferred-work.js";
import { resetTraceLog, setTraceSink, type SpanRecord } from "../context/index.js";

/** Resolve after `ms` of real time — used to force lane interleaving. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A manually-released gate. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

describe("DeferredWork", () => {
  beforeEach(() => {
    resetTraceLog();
  });

  it("serializes work within a lane (in enqueue order)", async () => {
    const dw = new DeferredWork();
    const order: string[] = [];

    dw.enqueue("scribe", async () => { await sleep(10); order.push("a"); });
    dw.enqueue("scribe", async () => { order.push("b"); });

    await dw.settle("test");
    // "b" was enqueued second on the same lane, so it waits for "a" despite "a"
    // sleeping — same lane never overlaps.
    expect(order).toEqual(["a", "b"]);
  });

  it("runs different lanes in parallel", async () => {
    const dw = new DeferredWork();
    const order: string[] = [];
    const g = gate();

    // Lane A is gated; lane B is free. If lanes were serialized B would block
    // behind A — instead B finishes first, then we release A.
    dw.enqueue("a", async () => { await g.promise; order.push("a"); });
    dw.enqueue("b", async () => { order.push("b"); });

    await sleep(0);
    expect(order).toEqual(["b"]);
    g.release();
    await dw.settle("test");
    expect(order).toEqual(["b", "a"]);
  });

  it("settle awaits every lane", async () => {
    const dw = new DeferredWork();
    let aDone = false, bDone = false;
    dw.enqueue("a", async () => { await sleep(15); aDone = true; });
    dw.enqueue("b", async () => { await sleep(5); bDone = true; });

    await dw.settle("test");
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });

  it("never throws from settle when a task fails, and a failed task does not poison its lane", async () => {
    const dw = new DeferredWork();
    const order: string[] = [];
    dw.enqueue("scribe", async () => { throw new Error("boom"); });
    dw.enqueue("scribe", async () => { order.push("after-failure"); });

    // settle resolves despite the throw...
    await expect(dw.settle("test")).resolves.toBeUndefined();
    // ...and the second task on the same lane still ran.
    expect(order).toEqual(["after-failure"]);
  });

  it("settle on an empty registry is an instant no-op", async () => {
    const spans: SpanRecord[] = [];
    setTraceSink((rec) => spans.push(rec));
    const dw = new DeferredWork();
    await dw.settle("test");
    expect(spans).toEqual([]);
  });

  it("records a barrier_wait span only when the settle actually blocks", async () => {
    const spans: SpanRecord[] = [];
    setTraceSink((rec) => spans.push(rec));

    // Injected clock: a 50ms wall-clock for the settle → over the epsilon.
    const ticks = [1000, 1050];
    const dw = new DeferredWork({ now: () => ticks.shift() ?? 1050 });
    dw.enqueue("scribe", async () => { /* resolved work */ });

    await dw.settle("next-turn");

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      kind: "barrier_wait",
      name: "next-turn",
      t0: 1000,
      t1: 1050,
      durMs: 50,
    });
  });

  it("writes no span when the settle is instant (under the epsilon)", async () => {
    const spans: SpanRecord[] = [];
    setTraceSink((rec) => spans.push(rec));

    // Injected clock with zero elapsed → no barrier_wait.
    const dw = new DeferredWork({ now: () => 1000 });
    dw.enqueue("scribe", async () => { /* resolved work */ });

    await dw.settle("next-turn");
    expect(spans.filter((s) => s.kind === "barrier_wait")).toEqual([]);
  });
});
