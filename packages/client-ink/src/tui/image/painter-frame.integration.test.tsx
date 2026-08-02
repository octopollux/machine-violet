/**
 * Integration rig for the inline-image painter's frame composition.
 *
 * Renders a REAL Ink app (fullscreen, incremental rendering, sync-write
 * combiner installed — the exact production stack from start-client.ts) into a
 * fake TTY stdout, registers a painter that emits a plain-text SENTINEL via
 * composePaint at a known app row, then feeds the captured byte stream through
 * @xterm/headless and reads the resulting screen grid.
 *
 * This answers, empirically and per-platform:
 *  1. CALIBRATION — which physical row does composePaint land on relative to
 *     the intended app row? (The cursor-resting-row math: fullscreen frames
 *     have no trailing newline, so where Ink parks the cursor is not obvious.)
 *  2. BLANKING — does a frame rewrite that doesn't change the painter's
 *     signature (win32 clearTerminal-every-frame; unrelated line updates)
 *     erase the painted content while an InlineImage-style signature-skip
 *     refuses to re-blit?
 *
 * The rig uses plain text as the "image" payload so the xterm grid shows
 * exactly where pixels would have landed — no graphics decoding needed.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import React from "react";
import { render, Box, Text } from "ink";
import { installSyncWriteCombiner } from "../hooks/syncWriteCombiner.js";
import {
  registerPainter,
  clearPainters,
  setIncrementalRendering,
  compositePainters,
} from "./painterRegistry.js";
import { composePaint, paintSignature, type PaintBox } from "./paint.js";
import { damageTouches, type FrameDamage } from "./frameDamage.js";

const COLS = 60;
const ROWS = 20;
// Fullscreen frames (app height == terminal rows) have no trailing newline, so
// Ink parks the cursor ON the last app row — the painter's positioning anchor.
const CURSOR_ROW = ROWS - 1;

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = COLS;
  rows = ROWS;
  chunks: string[] = [];
  write = (
    chunk: string | Uint8Array,
    encodingOrCb?: unknown,
    cb?: unknown,
  ): boolean => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    this.chunks.push(str);
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  };
}

function makeMockStdin(): NodeJS.ReadStream {
  const stream = new Readable({ read() { /* data arrives via push() */ } }) as NodeJS.ReadStream;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = function (mode: boolean) {
    stream.isRaw = mode;
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestAppProps {
  lines: string[];
}

function TestApp({ lines }: TestAppProps): React.ReactElement {
  return (
    <Box width={COLS} height={ROWS} flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate">{l}</Text>
      ))}
    </Box>
  );
}

const baseLines = (): string[] =>
  Array.from({ length: ROWS }, (_, i) => `L${String(i).padStart(2, "0")} narrative text row`);

interface Rig {
  stdout: FakeStdout;
  rerender: (lines: string[]) => void;
  unmount: () => void;
  /** Feed everything written so far into the vterm; return the visible grid. */
  screen: () => Promise<string[]>;
}

async function makeRig(initialLines: string[]): Promise<Rig> {
  const stdout = new FakeStdout();
  const stdin = makeMockStdin();
  const { Terminal } = await import("@xterm/headless");
  // convertEol emulates the tty line discipline's ONLCR (LF → CRLF), which a
  // real terminal gets from the kernel driver but a raw vterm feed does not.
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, convertEol: true });

  setIncrementalRendering(true);
  const removeCombiner = installSyncWriteCombiner(
    stdout as unknown as NodeJS.WriteStream,
    compositePainters,
  );

  const instance = render(<TestApp lines={initialLines} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    interactive: true,
    incrementalRendering: true,
    alternateScreen: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    stdout,
    rerender: (lines) => instance.rerender(<TestApp lines={lines} />),
    unmount: () => {
      instance.unmount();
      removeCombiner();
      term.dispose();
    },
    screen: async () => {
      const pending = stdout.chunks.splice(0).join("");
      if (pending.length > 0) {
        await new Promise<void>((r) => term.write(pending, r));
      }
      const buf = term.buffer.active;
      const rows: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        rows.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
      }
      return rows;
    },
  };
}

/** Row index (0-based) where the sentinel string landed, or -1. */
const findSentinel = (grid: string[], sentinel: string): number =>
  grid.findIndex((row) => row.includes(sentinel));

afterEach(() => {
  clearPainters();
  setIncrementalRendering(false);
});

describe("painter frame composition (real Ink + vterm)", () => {
  it("calibration: composePaint lands the payload on the intended app row", async () => {
    const rig = await makeRig(baseLines());
    const TARGET_ROW = 7;
    const SENTINEL = "#SENTINEL#";
    let prev: PaintBox | null = null;
    registerPainter("test", () => {
      const box: PaintBox = { row: TARGET_ROW, col: 30, rows: 1, cols: SENTINEL.length };
      const out = composePaint(SENTINEL, box, prev, CURSOR_ROW, []);
      prev = box;
      return out;
    });

    // First frame may have flushed before the painter registered; force one.
    rig.rerender(baseLines().map((l, i) => (i === ROWS - 1 ? l + "!" : l)));
    await delay(150);
    const grid = await rig.screen();
    rig.unmount();

    const at = findSentinel(grid, SENTINEL);
    expect(at, `sentinel landed on row ${at}:\n${grid.join("\n")}`).toBe(TARGET_ROW);
    // The rest of the target row must be the original text (payload spliced in place).
    expect(grid[TARGET_ROW]).toContain("L07");
  });

  it("blanking: a signature-skipping painter survives an unrelated line update", async () => {
    const rig = await makeRig(baseLines());
    const TARGET_ROW = 7;
    const SENTINEL = "#SENTINEL#";
    // InlineImage-style idempotent painter: skip when the signature is
    // unchanged AND this frame's bytes left the band's rows alone — the
    // production skip. On win32 (Ink clears every fullscreen frame) and on any
    // frame that rewrites the band's rows, damage forces the re-blit; a
    // signature-only skip left the sentinel wiped (the original blanking bug,
    // captured before the fix by this same rig).
    let prev: PaintBox | null = null;
    let prevSig: string | null = null;
    registerPainter("test", (damage: FrameDamage) => {
      const box: PaintBox = { row: TARGET_ROW, col: 30, rows: 1, cols: SENTINEL.length };
      const sig = paintSignature(box, 0, CURSOR_ROW, 0);
      const clobbered = damageTouches(damage, box.row, box.rows, CURSOR_ROW);
      if (!clobbered && sig !== null && prev !== null && sig === prevSig) return "";
      const out = composePaint(SENTINEL, box, prev, CURSOR_ROW, []);
      prev = box;
      prevSig = sig;
      return out;
    });

    rig.rerender(baseLines().map((l, i) => (i === ROWS - 1 ? l + "!" : l)));
    await delay(150);
    const gridBefore = await rig.screen();
    expect(findSentinel(gridBefore, SENTINEL), `pre-update:\n${gridBefore.join("\n")}`).toBeGreaterThanOrEqual(0);

    // Unrelated update: only the last line changes; the sentinel's row does not.
    rig.rerender(baseLines().map((l, i) => (i === ROWS - 1 ? l + "!!" : l)));
    await delay(150);
    const gridAfter = await rig.screen();
    rig.unmount();

    const at = findSentinel(gridAfter, SENTINEL);
    expect(at, `post-update sentinel gone:\n${gridAfter.join("\n")}`).toBeGreaterThanOrEqual(0);
  });
});
