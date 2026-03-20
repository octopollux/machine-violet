import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installRawModeGuard, forceRefreshRawMode } from "./rawModeGuard.js";
import type { RawModeGuardStdin } from "./rawModeGuard.js";

function makeStdin(options?: { isTTY?: boolean }): {
  stdin: RawModeGuardStdin & {
    setRawMode: (mode: boolean) => unknown;
    isRaw: boolean;
  };
  calls: boolean[];
} {
  const calls: boolean[] = [];
  const stdin: RawModeGuardStdin & { isRaw: boolean; setRawMode: (mode: boolean) => unknown } = {
    isTTY: options?.isTTY ?? true,
    isRaw: true,
    setRawMode: vi.fn((mode: boolean) => {
      calls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    }),
  };
  return { stdin, calls };
}

describe("installRawModeGuard", () => {
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

  it("unlock restores original setRawMode", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    unlock();

    // setRawMode(false) should go through after unlock
    stdin.setRawMode(false);
    expect(calls).toEqual([false]);
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
});

describe("forceRefreshRawMode", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("toggles raw mode off then on to defeat libuv cache", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    forceRefreshRawMode();

    // Should see false then true via the original setRawMode
    expect(calls).toEqual([false, true]);
    unlock();
  });

  it("is a no-op when no guard is installed", () => {
    // No guard installed — should not throw
    expect(() => forceRefreshRawMode()).not.toThrow();
  });

  it("is a no-op on non-Windows platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    forceRefreshRawMode();

    expect(calls).toEqual([]);
    unlock();
  });

  it("swallows errors during shutdown", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    // Simulate stdin becoming destroyed after guard is installed —
    // make the captured original throw on subsequent calls.
    unlock();

    let callCount = 0;
    const conditionalStdin = {
      isTTY: true,
      isRaw: true,
      setRawMode: vi.fn((_mode: boolean) => {
        callCount++;
        // First call (install) succeeds; subsequent calls (forceRefresh) throw
        if (callCount > 1) throw new Error("EPERM");
        return conditionalStdin;
      }),
    };
    const unlock2 = installRawModeGuard(conditionalStdin);

    expect(() => forceRefreshRawMode()).not.toThrow();
    unlock2();
  });
});
