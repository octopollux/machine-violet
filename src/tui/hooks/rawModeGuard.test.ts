import { describe, it, expect, vi, afterEach } from "vitest";
import { installRawModeGuard, WATCHDOG_INTERVAL_MS } from "./rawModeGuard.js";

function makeStdin(options?: { isTTY?: boolean }) {
  const calls: boolean[] = [];
  const stdin = {
    isTTY: options?.isTTY ?? true,
    isRaw: true,
    setRawMode: vi.fn((mode: boolean) => {
      calls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    }),
  } as unknown as NodeJS.ReadStream & {
    setRawMode: (mode: boolean) => NodeJS.ReadStream;
    isRaw: boolean;
    isTTY: boolean;
  };
  return { stdin, calls };
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
    stdin.isRaw = false;
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(calls).toEqual([]);
  });

  it("is a no-op when stdin has no setRawMode", () => {
    const stdin = {} as NodeJS.ReadStream;
    const unlock = installRawModeGuard(stdin as never);
    expect(unlock).toBeTypeOf("function");
    unlock(); // should not throw
  });

  it("is a no-op when stdin is not a TTY", () => {
    const { stdin, calls } = makeStdin({ isTTY: false });
    const unlock = installRawModeGuard(stdin);
    // Should not have called setRawMode at all
    expect(calls).toEqual([]);
    unlock();
  });

  it("watchdog re-asserts raw mode when externally disabled", () => {
    vi.useFakeTimers();
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    // Simulate OS externally disabling raw mode
    stdin.isRaw = false;

    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
    expect(calls).toContain(true);
    expect(stdin.isRaw).toBe(true);
    unlock();
  });

  it("watchdog does not call setRawMode when already raw", () => {
    vi.useFakeTimers();
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    // isRaw is already true — watchdog should not call setRawMode
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(calls).toEqual([]);
    unlock();
  });

  it("exports WATCHDOG_INTERVAL_MS as a positive number", () => {
    expect(WATCHDOG_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(WATCHDOG_INTERVAL_MS)).toBe(true);
  });
});
