import { describe, it, expect, vi } from "vitest";
import { checkAndRestoreRawMode } from "./useRawModeGuardian.js";
import type { RawModeStdin } from "./useRawModeGuardian.js";

function makeStdin(overrides: Partial<RawModeStdin> = {}): RawModeStdin & { setRawMode: ReturnType<typeof vi.fn> } {
  return {
    isTTY: true,
    isRaw: true,
    setRawMode: vi.fn(),
    ...overrides,
  };
}

describe("checkAndRestoreRawMode", () => {
  it("does nothing when isRaw is true", () => {
    const stdin = makeStdin({ isRaw: true });
    checkAndRestoreRawMode(stdin);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("calls setRawMode(true) when isRaw is false", () => {
    const stdin = makeStdin({ isRaw: false });
    checkAndRestoreRawMode(stdin);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
  });

  it("does nothing when isTTY is false", () => {
    const stdin = makeStdin({ isTTY: false, isRaw: false });
    checkAndRestoreRawMode(stdin);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("does nothing when isTTY is undefined", () => {
    const stdin = makeStdin({ isTTY: undefined, isRaw: false });
    checkAndRestoreRawMode(stdin);
    expect(stdin.setRawMode).not.toHaveBeenCalled();
  });

  it("calls onRestore callback when restoring raw mode", () => {
    const stdin = makeStdin({ isRaw: false });
    const onRestore = vi.fn();
    checkAndRestoreRawMode(stdin, onRestore);
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("does not call onRestore when no restore needed", () => {
    const stdin = makeStdin({ isRaw: true });
    const onRestore = vi.fn();
    checkAndRestoreRawMode(stdin, onRestore);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("handles setRawMode throwing (shutdown race)", () => {
    const stdin = makeStdin({ isRaw: false });
    stdin.setRawMode.mockImplementation(() => { throw new Error("EPERM"); });
    // Should not throw
    expect(() => checkAndRestoreRawMode(stdin)).not.toThrow();
  });

  it("handles missing setRawMode gracefully", () => {
    const stdin: RawModeStdin = { isTTY: true, isRaw: false };
    expect(() => checkAndRestoreRawMode(stdin)).not.toThrow();
  });
});
