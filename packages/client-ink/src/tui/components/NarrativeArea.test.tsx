import React, { useRef, useEffect } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import type { NarrativeLine, ProcessedLine } from "@machine-violet/shared/types/tui.js";
import { processNarrativeLines, toPlainText } from "../formatting.js";
import { GameProvider, type GameContextValue } from "../game-context.js";
import { clearPainters } from "../image/painterRegistry.js";
import {
  checkpointForScrollOffset,
  narrativeLineKeys,
  useProcessedLines,
  NarrativeArea,
} from "./NarrativeArea.js";

// Sharp is mocked so the remount-detection test below can (a) run without real
// image files and (b) count decode activity: every InlineImage mount calls
// `sharp(path)` from its metadata + decode effects, so a remount shows up as
// new calls after the tree has settled.
vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    metadata: async () => ({ width: 64, height: 32 }),
    resize: (w: number, h: number) => ({
      ensureAlpha: () => ({
        raw: () => ({
          toBuffer: async () => ({ data: Buffer.alloc(w * h * 4), info: { width: w, height: h } }),
        }),
      }),
    }),
  })),
}));


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
const checkpoint = (hp: string): NarrativeLine => ({
  kind: "metadata",
  text: "",
  event: {
    type: "state_checkpoint",
    state: {
      version: 1,
      modelines: { Aldric: `HP ${hp}` },
      displayResources: { Aldric: ["HP"] },
      resourceValues: { Aldric: { HP: hp } },
    },
  },
});

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

describe("NarrativeArea transcript checkpoints", () => {
  it("preserves checkpoints through processing without rendering text", () => {
    const lines = [dm("The gate falls."), checkpoint("18/30")];
    const processed = processNarrativeLines(lines, 80);
    expect(processed[1].kind).toBe("metadata");
    expect(processed[1].metadata?.type).toBe("state_checkpoint");
    if (processed[1].metadata?.type !== "state_checkpoint") {
      throw new Error("expected state checkpoint metadata");
    }
    expect(processed[1].metadata.state.resourceValues.Aldric.HP).toBe("18/30");

    const { lastFrame } = render(
      <NarrativeArea lines={lines} maxRows={20} width={80} />,
    );
    expect(lastFrame()).toContain("The gate falls.");
    expect(lastFrame()).not.toContain("18/30");
  });

  it("selects the checkpoint that closes the visible turn", () => {
    const processed = processNarrativeLines([
      dm("Turn one"),
      checkpoint("18/30"),
      dm("Turn two"),
      checkpoint("12/30"),
    ], 80);
    const positions = new Map([
      [0, { top: 0, height: 1 }],
      [1, { top: 1, height: 0 }],
      [2, { top: 1, height: 1 }],
      [3, { top: 2, height: 0 }],
    ]);
    const getPosition = (index: number) => positions.get(index) ?? null;

    expect(checkpointForScrollOffset(processed, 0, getPosition)?.resourceValues.Aldric.HP).toBe("18/30");
    expect(checkpointForScrollOffset(processed, 1, getPosition)?.resourceValues.Aldric.HP).toBe("18/30");
    expect(checkpointForScrollOffset(processed, 1.5, getPosition)?.resourceValues.Aldric.HP).toBe("12/30");
    expect(checkpointForScrollOffset(processed, 3, getPosition)?.resourceValues.Aldric.HP).toBe("12/30");
  });
});

describe("narrativeLineKeys", () => {
  const img = (path: string): ProcessedLine => ({ kind: "image", nodes: [path], intent: "scene_snapshot" } as never);
  const text = (t: string): ProcessedLine => ({ kind: "dm", nodes: [t] } as never);

  it("keys image lines by path, independent of position (#781)", () => {
    const image = img("/campaign/images/scene-001.png");
    const before = narrativeLineKeys([text("a"), image, text("b")]);
    // Insert two lines above — the image key must not move with its index.
    const after = narrativeLineKeys([text("x"), text("y"), text("a"), image, text("b")]);
    expect(before[1]).toBe("img:/campaign/images/scene-001.png:0");
    expect(after[3]).toBe(before[1]);
  });

  it("disambiguates repeated paths by append-order occurrence", () => {
    const p = "/campaign/images/scene-001.png";
    const keys = narrativeLineKeys([img(p), text("a"), img(p)]);
    expect(keys[0]).toBe(`img:${p}:0`);
    expect(keys[2]).toBe(`img:${p}:1`);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps index keys for non-image lines", () => {
    expect(narrativeLineKeys([text("a"), text("b")])).toEqual([0, 1]);
  });
});

describe("image line remounts (#781)", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("inserting a line above an image does not remount/re-decode it", async () => {
    const sharp = (await import("sharp")).default as unknown as ReturnType<typeof vi.fn>;
    clearPainters();
    const imagePath = "/fake/scene-001.png";
    const gameCtx = {
      graphicsCaps: { kitty: false, iterm2: false, sixel: true, cellPixels: { width: 10, height: 20 }, sixelColorRegisters: 256 },
      stdinFilterChain: null,
      usageStatus: null,
    } as unknown as GameContextValue;
    const image: NarrativeLine = { kind: "image", text: imagePath, intent: "scene_snapshot" };
    const base: NarrativeLine[] = [dm("Above."), dm(""), image, dm("Below.")];

    const ui = (lines: NarrativeLine[]) => (
      <GameProvider value={gameCtx}>
        <NarrativeArea lines={lines} maxRows={16} width={40} viewportTop={0} />
      </GameProvider>
    );
    const { rerender, unmount } = render(ui(base));
    await delay(120); // metadata + decode effects settle
    const settled = sharp.mock.calls.length;
    expect(settled).toBeGreaterThan(0); // the image actually mounted + decoded

    // Reflow: new content ABOVE the image shifts every subsequent index.
    rerender(ui([dm("Inserted!"), dm(""), ...base]));
    await delay(120);
    // Same InlineImage instance → no new metadata read, no re-decode. (With
    // index keys this was a full remount: dispose + fresh sharp decode.)
    expect(sharp.mock.calls.length).toBe(settled);

    unmount();
    clearPainters();
  });
});
