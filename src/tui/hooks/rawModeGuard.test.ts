import { describe, it, expect, vi } from "vitest";
import { installRawModeGuard } from "./rawModeGuard.js";

function makeStdin() {
  const calls: boolean[] = [];
  const stdin = {
    setRawMode: vi.fn((mode: boolean) => {
      calls.push(mode);
      return stdin;
    }),
  } as unknown as NodeJS.ReadStream & { setRawMode: (mode: boolean) => NodeJS.ReadStream };
  return { stdin, calls };
}

describe("installRawModeGuard", () => {
  it("calls setRawMode(true) on install", () => {
    const { stdin, calls } = makeStdin();
    installRawModeGuard(stdin);
    // The guard calls original setRawMode(true) to ensure raw mode is on
    expect(calls).toContain(true);
  });

  it("allows setRawMode(true) through", () => {
    const { stdin, calls } = makeStdin();
    installRawModeGuard(stdin);
    calls.length = 0;

    stdin.setRawMode(true);
    expect(calls).toEqual([true]);
  });

  it("blocks setRawMode(false)", () => {
    const { stdin, calls } = makeStdin();
    installRawModeGuard(stdin);
    calls.length = 0;

    stdin.setRawMode(false);
    expect(calls).toEqual([]); // false never reached original
  });

  it("returns stdin from blocked call", () => {
    const { stdin } = makeStdin();
    installRawModeGuard(stdin);

    const result = stdin.setRawMode(false);
    expect(result).toBe(stdin);
  });

  it("unlock restores original setRawMode", () => {
    const { stdin, calls } = makeStdin();
    const unlock = installRawModeGuard(stdin);
    calls.length = 0;

    unlock();

    stdin.setRawMode(false);
    expect(calls).toEqual([false]);
  });

  it("is a no-op when stdin has no setRawMode", () => {
    const stdin = {} as NodeJS.ReadStream;
    const unlock = installRawModeGuard(stdin as never);
    expect(unlock).toBeTypeOf("function");
    unlock(); // should not throw
  });
});
