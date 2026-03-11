/**
 * Tests for the batched narrative lines hook.
 *
 * Uses ink-testing-library with real timers and small delays
 * so React can process state updates between assertions.
 */
import React, { useEffect, useRef } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useBatchedNarrativeLines } from "./useBatchedNarrativeLines.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("useBatchedNarrativeLines", () => {
  it("starts with empty lines", () => {
    function C() {
      const { lines } = useBatchedNarrativeLines();
      return <Text>{lines.length === 0 ? "empty" : "has-lines"}</Text>;
    }
    const { lastFrame } = render(<C />);
    expect(lastFrame()!).toContain("empty");
  });

  it("direct set flushes immediately", async () => {
    function C() {
      const { lines, setLines } = useBatchedNarrativeLines();
      const didSet = useRef(false);
      useEffect(() => {
        if (!didSet.current) {
          didSet.current = true;
          setLines([{ kind: "dm", text: "Hello" }]);
        }
      }, [setLines]);
      return <Text>{lines.map((l) => l.text).join("|") || "empty"}</Text>;
    }
    const { lastFrame } = render(<C />);
    await sleep(50);
    expect(lastFrame()!).toContain("Hello");
  });

  it("batches functional updates and flushes on timer", async () => {
    const INTERVAL = 30;
    function C() {
      const { lines, setLines } = useBatchedNarrativeLines(INTERVAL);
      const step = useRef(0);
      useEffect(() => {
        if (step.current === 0) {
          step.current = 1;
          // Fire two functional updates in quick succession
          setLines(() => [{ kind: "dm", text: "A" }]);
          setLines((prev) => [...prev, { kind: "dm", text: "B" }]);
        }
      }, [setLines]);
      return <Text>{lines.length === 0 ? "empty" : `count:${lines.length}`}</Text>;
    }
    const { lastFrame } = render(<C />);
    // Before flush interval
    expect(lastFrame()!).toContain("empty");
    // Wait for flush
    await sleep(INTERVAL + 50);
    expect(lastFrame()!).toContain("count:2");
  });

  it("direct set clears pending functional updates", async () => {
    function C() {
      const { lines, setLines } = useBatchedNarrativeLines(200);
      const step = useRef(0);
      useEffect(() => {
        if (step.current === 0) {
          step.current = 1;
          // Queue a functional update (would produce "old")
          setLines(() => [{ kind: "dm", text: "old" }]);
          // Immediately replace with a direct set
          setLines([{ kind: "system", text: "new" }]);
        }
      }, [setLines]);
      return <Text>{lines.map((l) => l.text).join("|") || "empty"}</Text>;
    }
    const { lastFrame } = render(<C />);
    await sleep(50);
    expect(lastFrame()!).toContain("new");
    // After the original flush interval, should still show "new" not "old"
    await sleep(250);
    expect(lastFrame()!).toContain("new");
  });
});
