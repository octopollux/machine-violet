import { describe, it, expect, vi } from "vitest";
import { installRawModeGuard } from "./rawModeGuard.js";
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
