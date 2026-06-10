/**
 * Tests for buildSegments — the grouping/ordering transform that turns a flat
 * span list into per-turn flame-chart segments. Pure logic; the React chart is
 * verified live.
 */
import { describe, it, expect } from "vitest";
import { buildSegments } from "../src/client/components/FlameChart";
import type { SpanRecord } from "../src/shared/protocol";

function span(p: Partial<SpanRecord> & { id: number; turnId: number; parentId: number | null }): SpanRecord {
  return {
    campaignId: "demo",
    kind: "tool",
    name: `span-${p.id}`,
    t0: 0,
    t1: 1,
    durMs: 1,
    ...p,
  };
}

describe("buildSegments", () => {
  it("groups by turnId and sorts segments by root start time", () => {
    const spans: SpanRecord[] = [
      span({ id: 10, turnId: 10, parentId: null, kind: "turn", t0: 200, t1: 260, durMs: 60 }),
      span({ id: 11, turnId: 10, parentId: 10, kind: "agent", t0: 200, t1: 250, durMs: 50 }),
      span({ id: 1, turnId: 1, parentId: null, kind: "turn", t0: 100, t1: 140, durMs: 40 }),
      span({ id: 2, turnId: 1, parentId: 1, kind: "agent", t0: 100, t1: 138, durMs: 38 }),
    ];
    const segments = buildSegments(spans);
    expect(segments.map((s) => s.turnId)).toEqual([1, 10]); // sorted by t0
    expect(segments[0].spans).toHaveLength(2);
    expect(segments[0].root.id).toBe(1);
  });

  it("drops a fragment whose root was tailed off (no parentId === null span)", () => {
    const spans: SpanRecord[] = [
      // turn 1 root present
      span({ id: 1, turnId: 1, parentId: null, kind: "turn" }),
      span({ id: 2, turnId: 1, parentId: 1, kind: "agent" }),
      // turn 5 root (id 5) missing — only an orphaned child survives the tail
      span({ id: 7, turnId: 5, parentId: 5, kind: "agent" }),
    ];
    const segments = buildSegments(spans);
    expect(segments.map((s) => s.turnId)).toEqual([1]);
  });

  it("keeps a detached background root as its own segment", () => {
    const spans: SpanRecord[] = [
      span({ id: 1, turnId: 1, parentId: null, kind: "turn", t0: 0, t1: 10, durMs: 10 }),
      span({ id: 9, turnId: 9, parentId: null, kind: "background", name: "suggested_choices", t0: 11, t1: 15, durMs: 4 }),
    ];
    const segments = buildSegments(spans);
    expect(segments.map((s) => s.root.kind)).toEqual(["turn", "background"]);
  });

  it("derives turn duration from the furthest child end, not just the root", () => {
    const spans: SpanRecord[] = [
      span({ id: 1, turnId: 1, parentId: null, kind: "turn", t0: 0, t1: 30, durMs: 30 }),
      // a deferred subagent that finished after the root's own t1
      span({ id: 2, turnId: 1, parentId: 1, kind: "agent", t0: 25, t1: 45, durMs: 20 }),
    ];
    const [seg] = buildSegments(spans);
    expect(seg.durMs).toBe(45); // max child t1 (45) - root t0 (0)
  });
});
