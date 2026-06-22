import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StallWatchdog } from "./stall-watchdog.js";

const TIMEOUT = 1000;

describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onStall after a full window of silence once armed", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.note(); // arm (turn start)
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does not fire if never armed", () => {
    const onStall = vi.fn();
    new StallWatchdog(TIMEOUT, onStall);
    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("re-arms on activity — the window restarts each note()", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.note();
    // Activity every 600ms keeps resetting a 1000ms window → never trips.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600);
      wd.note();
    }
    expect(onStall).not.toHaveBeenCalled();
    // Then go silent for a full window.
    vi.advanceTimersByTime(TIMEOUT);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("is paused for the whole of a tool dispatch, however long", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.note();
    wd.enterToolDispatch(); // e.g. a long image render
    vi.advanceTimersByTime(TIMEOUT * 100); // 100× the window
    expect(onStall).not.toHaveBeenCalled();
    wd.exitToolDispatch(); // re-arms
    vi.advanceTimersByTime(TIMEOUT);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("note() during a dispatch does not arm (stays paused)", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.enterToolDispatch();
    wd.note(); // codex shouldn't emit mid-dispatch, but if it does, stay paused
    vi.advanceTimersByTime(TIMEOUT * 3);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("stays paused until the LAST of concurrent dispatches exits (depth counter)", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.note();
    wd.enterToolDispatch();
    wd.enterToolDispatch(); // two concurrent tool calls
    wd.exitToolDispatch(); // one returns — still one outstanding
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(onStall).not.toHaveBeenCalled();
    wd.exitToolDispatch(); // last returns — re-arms
    vi.advanceTimersByTime(TIMEOUT);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("clear() cancels a pending fire and is idempotent", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.note();
    vi.advanceTimersByTime(TIMEOUT - 1);
    wd.clear();
    wd.clear(); // idempotent
    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("an extra exitToolDispatch can't drive depth negative and wedge the pause", () => {
    const onStall = vi.fn();
    const wd = new StallWatchdog(TIMEOUT, onStall);
    wd.exitToolDispatch(); // unbalanced — must not leave depth < 0
    wd.note();
    vi.advanceTimersByTime(TIMEOUT);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
