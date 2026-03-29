import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { forceRefreshRawMode } from "./rawModeGuard.js";
import { useRawModeGuardian } from "./useRawModeGuardian.js";

vi.mock("./rawModeGuard.js", () => ({
  forceRefreshRawMode: vi.fn(),
}));

const mockedForceRefresh = vi.mocked(forceRefreshRawMode);

function TestComponent({ enabled = true, intervalMs }: { enabled?: boolean; intervalMs?: number }) {
  useRawModeGuardian({ enabled, intervalMs });
  return React.createElement(Text, null, "test");
}

describe("useRawModeGuardian", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedForceRefresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("calls forceRefreshRawMode on interval on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const { unmount } = render(React.createElement(TestComponent, { intervalMs: 100 }));

    expect(mockedForceRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(mockedForceRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(mockedForceRefresh).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not call forceRefreshRawMode on non-Windows", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    const { unmount } = render(React.createElement(TestComponent, { intervalMs: 100 }));

    vi.advanceTimersByTime(500);
    expect(mockedForceRefresh).not.toHaveBeenCalled();

    unmount();
  });

  it("does not poll when enabled is false", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const { unmount } = render(React.createElement(TestComponent, { enabled: false, intervalMs: 100 }));

    vi.advanceTimersByTime(500);
    expect(mockedForceRefresh).not.toHaveBeenCalled();

    unmount();
  });

  it("cleans up interval on unmount", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const { unmount } = render(React.createElement(TestComponent, { intervalMs: 100 }));

    vi.advanceTimersByTime(100);
    expect(mockedForceRefresh).toHaveBeenCalledTimes(1);

    unmount();

    vi.advanceTimersByTime(500);
    // No additional calls after unmount
    expect(mockedForceRefresh).toHaveBeenCalledTimes(1);
  });

  it("uses default 500ms interval", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    const { unmount } = render(React.createElement(TestComponent));

    vi.advanceTimersByTime(499);
    expect(mockedForceRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockedForceRefresh).toHaveBeenCalledTimes(1);

    unmount();
  });
});
