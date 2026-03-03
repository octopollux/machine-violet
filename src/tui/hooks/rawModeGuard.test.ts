import { describe, it, expect, vi, afterEach } from "vitest";
import { installRawModeGuard, WATCHDOG_INTERVAL_MS } from "./rawModeGuard.js";
import type { RawModeGuardStdin } from "./rawModeGuard.js";

function makeStdin(options?: { isTTY?: boolean }): {
  stdin: RawModeGuardStdin & {
    setRawMode: (mode: boolean) => unknown;
    isRaw: boolean;
  };
  calls: boolean[];
  readableListeners: (() => void)[];
} {
  const calls: boolean[] = [];
  const readableListeners: (() => void)[] = [];
  const stdin: RawModeGuardStdin & { isRaw: boolean; setRawMode: (mode: boolean) => unknown } = {
    isTTY: options?.isTTY ?? true,
    isRaw: true,
    setRawMode: vi.fn((mode: boolean) => {
      calls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    }),
    prependListener: vi.fn((_event: string, listener: () => void) => {
      readableListeners.push(listener);
      return stdin;
    }),
    removeListener: vi.fn((_event: string, listener: () => void) => {
      const idx = readableListeners.indexOf(listener);
      if (idx >= 0) readableListeners.splice(idx, 1);
      return stdin;
    }),
  };
  return { stdin, calls, readableListeners };
}

describe("installRawModeGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls setRawMode(true) on install", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    expect(calls).toContain(true);
    unlock();
  });

  it("allows setRawMode(true) through", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    stdin.setRawMode(true);
    expect(calls).toEqual([true]);
    unlock();
  });

  it("blocks setRawMode(false)", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    stdin.setRawMode(false);
    expect(calls).toEqual([]); // false never reached original
    unlock();
  });

  it("returns stdin from blocked call", () => {
    const { stdin } = makeStdin();
    const unlock = installRawModeGuard(stdin);

    const result = stdin.setRawMode(false);
    expect(result).toBe(stdin);
    unlock();
  });

  it("unlock restores original setRawMode and stops watchdog", () => {
    vi.useFakeTimers();
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    unlock();

    // setRawMode(false) should go through after unlock
    stdin.setRawMode(false);
    expect(calls).toEqual([false]);

    // Watchdog should no longer fire
    calls.length = 0;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(calls).toEqual([]);
  });

  it("is a no-op when stdin has no setRawMode", () => {
    const stdin = {} as RawModeGuardStdin;
    const unlock = installRawModeGuard(stdin);
    expect(unlock).toBeTypeOf("function");
    unlock(); // should not throw
  });

  it("is a no-op when stdin is not a TTY", () => {
    const { stdin, calls } = makeStdin({ isTTY: false });
    const unlock = installRawModeGuard(stdin);
    expect(calls).toEqual([]);
    unlock();
  });

  it("watchdog unconditionally re-asserts raw mode", () => {
    vi.useFakeTimers();
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    // isRaw is true — watchdog should STILL call setRawMode(true)
    // because it's unconditional (isRaw can be stale)
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(calls).toContain(true);
    unlock();
  });

  it("pre-read hook re-asserts raw mode on readable", () => {
    const { stdin, calls, readableListeners } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    // Simulate a readable event
    expect(readableListeners.length).toBeGreaterThan(0);
    readableListeners[0]!();

    expect(calls).toContain(true);
    unlock();
  });

  it("unlock removes the readable listener", () => {
    const { stdin, readableListeners } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    expect(readableListeners.length).toBe(1);

    unlock();
    expect(readableListeners.length).toBe(0);
  });

  it("exports WATCHDOG_INTERVAL_MS as a positive number", () => {
    expect(WATCHDOG_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(WATCHDOG_INTERVAL_MS)).toBe(true);
  });
});
