import { describe, it, expect, vi } from "vitest";
import type { ServerEvent } from "@machine-violet/shared";
import { createBridge } from "./bridge.js";

describe("createBridge onRollback", () => {
  // Issue #431: a streaming retry leaves partial deltas accumulated on the
  // client. The bridge needs to drop its own un-flushed buffer (so a stale
  // tail-fragment doesn't sneak out after the corrective snapshot) and
  // delegate to the consumer (typically SessionManager) which knows the
  // snapshot shape.
  it("drops un-flushed delta buffer on rollback", () => {
    const events: ServerEvent[] = [];
    const cb = createBridge({
      broadcast: (e) => events.push(e),
    });

    // Push deltas that don't end at a word boundary — they sit in the
    // bridge's internal buffer waiting to be flushed at the next boundary.
    cb.onNarrativeDelta("Mid-word fragment");

    // No flush yet — still buffered.
    expect(events.filter((e) => e.type === "narrative:chunk")).toHaveLength(0);

    cb.onRollback?.();

    // Buffer should be discarded — no chunk event leaks out.
    expect(events.filter((e) => e.type === "narrative:chunk")).toHaveLength(0);

    // After rollback, a fresh delta starts a clean buffer (no carry-over).
    cb.onNarrativeDelta("Fresh attempt ");
    const chunks = events.filter((e) => e.type === "narrative:chunk");
    expect(chunks).toHaveLength(1);
    expect((chunks[0].data as { text: string }).text).toBe("Fresh attempt ");
  });

  it("calls consumer onRollback after clearing its own buffer", () => {
    const onRollback = vi.fn();
    const events: ServerEvent[] = [];
    const cb = createBridge({
      broadcast: (e) => events.push(e),
      onRollback,
    });

    cb.onNarrativeDelta("partial ");
    cb.onRollback?.();

    expect(onRollback).toHaveBeenCalledOnce();
  });

  it("works without consumer onRollback (silent rollback)", () => {
    // A bridge created without an onRollback option still cleans up its
    // own state without throwing — the consumer just doesn't get notified.
    const events: ServerEvent[] = [];
    const cb = createBridge({
      broadcast: (e) => events.push(e),
    });

    cb.onNarrativeDelta("partial ");
    expect(() => cb.onRollback?.()).not.toThrow();
  });
});
