import { describe, it, expect, vi } from "vitest";
import type { ServerEvent } from "@machine-violet/shared";
import { createBridge } from "./bridge.js";
import { CodexTurnFailedError } from "../providers/openai-chatgpt/provider.js";

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

describe("createBridge onTuiCommand routing", () => {
  // Issue #559: show_rollback_summary must spread its payload onto the
  // activity:update event so the `summary` survives to the client. Without an
  // explicit case it falls to the default branch, which broadcasts only the
  // engineState discriminant and silently drops the summary.
  it("forwards show_rollback_summary with the summary payload intact", () => {
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });

    cb.onTuiCommand?.({ type: "show_rollback_summary", summary: "Restored to scene 3 (4 turns undone)." });

    const e = events.find((ev) => ev.type === "activity:update");
    expect(e).toBeDefined();
    const data = e!.data as { engineState?: string; summary?: string };
    expect(data.engineState).toBe("tui:show_rollback_summary");
    expect(data.summary).toBe("Restored to scene 3 (4 turns undone).");
  });

  it("drops the summary on the default branch when no case matches (regression guard)", () => {
    // Sanity check that the default branch really does omit extra payload —
    // this is the bug the explicit case above fixes.
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });

    cb.onTuiCommand?.({ type: "some_unhandled_command", summary: "dropped" } as never);

    const e = events.find((ev) => ev.type === "activity:update");
    expect(e).toBeDefined();
    const data = e!.data as { engineState?: string; summary?: string };
    expect(data.engineState).toBe("tui:some_unhandled_command");
    expect(data.summary).toBeUndefined();
  });
});

describe("createBridge error categories (#529)", () => {
  // The three-tier taxonomy is decided server-side; every WS error event
  // the bridge emits must carry the right discriminant so the client UX
  // (retry overlay vs main-menu banner vs hard error screen) matches.
  it("tags onRetry events as category=retryable", () => {
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });
    cb.onRetry(429, 2000);
    const e = events[0];
    expect(e.type).toBe("error");
    expect((e.data as { category?: string }).category).toBe("retryable");
    expect((e.data as { recoverable: boolean }).recoverable).toBe(true);
  });

  it("tags plain Error events as category=retryable on the onError callback path", () => {
    // GameEngine reports most failures via callbacks.onError without
    // rethrowing — that path is the *primary* surface for transient /
    // provider errors, so defaulting to retryable preserves the
    // pre-existing retry-overlay UX for anything we don't explicitly
    // recognise as session-fatal.
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });
    cb.onError(new Error("transient blip"));
    const e = events[0];
    expect((e.data as { category?: string }).category).toBe("retryable");
    expect((e.data as { recoverable: boolean }).recoverable).toBe(true);
  });

  it("still routes recognised session-fatal classes through onError to session-fatal-recoverable", () => {
    // CodexTurnFailedError → auth_expired / model_not_found / etc. should
    // drop to menu even when it arrives via the callback path rather than
    // via the thrown-error catch in session-manager.
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });
    cb.onError(new CodexTurnFailedError(
      "Your refresh token was already used. Please log out and sign in again.",
      "t_xyz",
    ));
    const e = events[0];
    expect((e.data as { category?: string }).category).toBe("session-fatal-recoverable");
    expect((e.data as { recoverable: boolean }).recoverable).toBe(false);
  });

  it("tags onRefusal (content classifier) as category=session-fatal-recoverable", () => {
    const events: ServerEvent[] = [];
    const cb = createBridge({ broadcast: (e) => events.push(e) });
    cb.onRefusal();
    const e = events[0];
    expect((e.data as { category?: string }).category).toBe("session-fatal-recoverable");
  });
});
