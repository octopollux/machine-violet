import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { disableAutowrap, restoreAutowrap } from "./autowrap.js";

function fakeStdout() {
  const writes: string[] = [];
  return { writes, write: (s: string) => (writes.push(s), true) };
}

describe("autowrap guard", () => {
  beforeEach(() => {
    // Ensure a clean module state between tests (restore removes the exit net).
    restoreAutowrap(fakeStdout());
  });
  afterEach(() => {
    restoreAutowrap(fakeStdout());
    vi.restoreAllMocks();
  });

  it("disables autowrap with DECAWM off (CSI ?7l)", () => {
    const out = fakeStdout();
    disableAutowrap(out);
    expect(out.writes).toEqual(["\x1b[?7l"]);
  });

  it("is idempotent — a second disable does not re-emit", () => {
    const out = fakeStdout();
    disableAutowrap(out);
    disableAutowrap(out);
    expect(out.writes).toEqual(["\x1b[?7l"]);
  });

  it("restores autowrap with DECAWM on (CSI ?7h)", () => {
    disableAutowrap(fakeStdout());
    const out = fakeStdout();
    restoreAutowrap(out);
    expect(out.writes).toEqual(["\x1b[?7h"]);
  });

  it("restore is a no-op when never disabled", () => {
    const out = fakeStdout();
    restoreAutowrap(out);
    expect(out.writes).toEqual([]);
  });

  it("registers an exit safety-net that restores autowrap", () => {
    const onSpy = vi.spyOn(process, "on");
    const out = fakeStdout();
    disableAutowrap(out);

    const call = onSpy.mock.calls.find(([evt]) => evt === "exit");
    expect(call).toBeDefined();

    // Fire the registered exit handler and confirm it re-enables autowrap.
    const handler = call![1] as () => void;
    handler();
    expect(out.writes).toContain("\x1b[?7h");
  });

  it("re-disable works after a restore cycle", () => {
    disableAutowrap(fakeStdout());
    restoreAutowrap(fakeStdout());
    const out = fakeStdout();
    disableAutowrap(out);
    expect(out.writes).toEqual(["\x1b[?7l"]);
  });
});
