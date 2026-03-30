import React, { useRef, useEffect } from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import type { NarrativeLine, ProcessedLine } from "@machine-violet/shared/types/tui.js";
import { processNarrativeLines, toPlainText } from "../formatting.js";
import { useProcessedLines, NarrativeArea } from "./NarrativeArea.js";


// ---------------------------------------------------------------------------
// Test harness: renders the hook result as plain text so we can inspect it
// ---------------------------------------------------------------------------

function HookHarness({
  lines,
  width,
  quoteColor,
  onResult,
}: {
  lines: NarrativeLine[];
  width: number;
  quoteColor?: string;
  onResult: (result: ProcessedLine[]) => void;
}) {
  const result = useProcessedLines(lines, width, quoteColor);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  useEffect(() => { onResultRef.current(result); });
  const text = result.map((l) => toPlainText(l.nodes)).join("|");
  return <Text>{text || " "}</Text>;
}

const dm = (text: string): NarrativeLine => ({ kind: "dm", text });
const dev = (text: string): NarrativeLine => ({ kind: "dev", text });

describe("useProcessedLines", () => {
  it("returns same output as direct processNarrativeLines", () => {
    const lines = [dm("Hello."), dm(""), dm("World.")];
    const expected = processNarrativeLines(lines, 80);

    let captured: ProcessedLine[] = [];
    render(
      <HookHarness lines={lines} width={80} onResult={(r) => { captured = r; }} />,
    );

    expect(captured).toEqual(expected);
  });

  it("frozen ProcessedLine objects are reference-stable across calls", () => {
    const line1 = dm("Paragraph one.");
    const blank = dm("");
    const line3 = dm("Streaming...");

    const initial = [line1, blank, line3];
    let prev: ProcessedLine[] = [];
    let current: ProcessedLine[] = [];

    const { rerender } = render(
      <HookHarness lines={initial} width={80} onResult={(r) => { prev = r; }} />,
    );

    // Append a new line in the same tail paragraph (prefix unchanged)
    const line4 = dm("More streaming.");
    const updated = [line1, blank, line3, line4];

    rerender(
      <HookHarness lines={updated} width={80} onResult={(r) => { current = r; }} />,
    );

    // The frozen prefix lines (before blank) should be reference-equal
    expect(current.length).toBeGreaterThan(prev.length);
    // First line should be the same object (from frozen cache)
    expect(current[0]).toBe(prev[0]);
  });

  it("cache invalidates on width change", () => {
    const lines = [dm("Hello world."), dm(""), dm("End.")];

    let result80: ProcessedLine[] = [];
    let result40: ProcessedLine[] = [];

    const { rerender } = render(
      <HookHarness lines={lines} width={80} onResult={(r) => { result80 = r; }} />,
    );

    rerender(
      <HookHarness lines={lines} width={40} onResult={(r) => { result40 = r; }} />,
    );

    // Width change should produce fresh results (not referencing old cache)
    const expected40 = processNarrativeLines(lines, 40);
    expect(result40).toEqual(expected40);
    // Should differ from 80-width result (though in this case text is short
    // enough that wrapping doesn't change — but the cache should still recompute)
    expect(result40).not.toBe(result80);
  });

  it("cache invalidates on quoteColor change", () => {
    const lines = [dm('She said "hello."'), dm(""), dm("End.")];

    let resultA: ProcessedLine[] = [];
    let resultB: ProcessedLine[] = [];

    const { rerender } = render(
      <HookHarness lines={lines} width={80} quoteColor="#aaa" onResult={(r) => { resultA = r; }} />,
    );

    rerender(
      <HookHarness lines={lines} width={80} quoteColor="#bbb" onResult={(r) => { resultB = r; }} />,
    );

    const expectedB = processNarrativeLines(lines, 80, "#bbb");
    expect(resultB).toEqual(expectedB);
    // Different quoteColor should produce different results for the quoted line
    expect(resultB).not.toBe(resultA);
  });

  it("handles no blank DM lines (full process)", () => {
    const lines = [dm("Line one."), dm("Line two.")];

    let captured: ProcessedLine[] = [];
    render(
      <HookHarness lines={lines} width={80} onResult={(r) => { captured = r; }} />,
    );

    const expected = processNarrativeLines(lines, 80);
    expect(captured).toEqual(expected);
  });
});

describe("NarrativeArea dev-line filtering", () => {
  it("filters out dev lines when showVerbose is false", () => {
    const lines: NarrativeLine[] = [
      dm("Hello world."),
      dev("[dev] tool:read → some data"),
      dm("More narration."),
    ];

    const { lastFrame } = render(
      <NarrativeArea lines={lines} maxRows={20} width={80} showVerbose={false} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Hello world.");
    expect(frame).toContain("More narration.");
    expect(frame).not.toContain("[dev]");
    expect(frame).not.toContain("tool:read");
  });

  it("shows dev lines when showVerbose is true", () => {
    const lines: NarrativeLine[] = [
      dm("Hello world."),
      dev("[dev] tool:read → some data"),
    ];

    const { lastFrame } = render(
      <NarrativeArea lines={lines} maxRows={20} width={80} showVerbose={true} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Hello world.");
    expect(frame).toContain("[dev] tool:read");
  });
});
