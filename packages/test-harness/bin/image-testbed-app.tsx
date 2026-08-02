/**
 * Visual testbed app for the inline-image renderer (issues #778/#780/#781).
 *
 * A minimal, API-key-free stand-in for the game screen that exercises the REAL
 * narrative stack: Ink (fullscreen, incremental rendering), the sync-write
 * combiner + painter registry, and the production `NarrativeArea` (incremental
 * line pipeline, ScrollView virtual scroll, content-stable line keys, real
 * InlineImage wiring) with forced graphics caps. Drive it from a
 * graphics-capable terminal or the xterm.js browser rig
 * (`npm run image-testbed` — see image-testbed-server.ts) and eyeball:
 *
 *  - the image renders between its marker lines (IMG-ABOVE / IMG-BELOW);
 *  - PgUp/PgDn/j/k scrolling keeps it glued to those markers, band-cropped at
 *    the viewport edges;
 *  - the 1Hz tick (idle-frame emulation) never blanks it;
 *  - `x` forces an unrelated re-render burst (the old blank trigger);
 *  - `a` inserts a narrative line ABOVE the image — every line index shifts,
 *    which used to remount the image and blink it out for a re-decode (#781).
 *
 * Env: COLS, ROWS (terminal size), CELL_W, CELL_H (cell pixels),
 * PROTOCOL (sixel | iterm2 | kitty, default sixel), IMAGE (optional PNG path).
 *
 * Run: node --import tsx/esm packages/test-harness/bin/image-testbed-app.tsx
 */
import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";
import { NarrativeArea, scrollAmount } from "../../client-ink/src/tui/components/NarrativeArea.js";
import type { NarrativeAreaHandle } from "../../client-ink/src/tui/components/NarrativeArea.js";
import { GameProvider, type GameContextValue } from "../../client-ink/src/tui/game-context.js";
import { OcclusionProvider } from "../../client-ink/src/tui/image/occlusion.js";
import { installSyncWriteCombiner } from "../../client-ink/src/tui/hooks/syncWriteCombiner.js";
import { compositePainters, setIncrementalRendering } from "../../client-ink/src/tui/image/painterRegistry.js";
import type { GraphicsCapabilities } from "../../client-ink/src/tui/image/capabilities.js";

const COLS = Number(process.env.COLS ?? 100);
const ROWS = Number(process.env.ROWS ?? 32);
const CELL_W = Number(process.env.CELL_W ?? 10);
const CELL_H = Number(process.env.CELL_H ?? 20);
const PROTOCOL = (process.env.PROTOCOL ?? "sixel") as "sixel" | "iterm2" | "kitty";

const caps: GraphicsCapabilities = {
  kitty: PROTOCOL === "kitty",
  iterm2: PROTOCOL === "iterm2",
  sixel: PROTOCOL === "sixel",
  cellPixels: { width: CELL_W, height: CELL_H },
  sixelColorRegisters: 256,
};

/** A test PNG whose content makes cropping/misposition obvious. */
async function makeTestImage(): Promise<string> {
  if (process.env.IMAGE) return process.env.IMAGE;
  const w = 640;
  const h = 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a4a8a"/><stop offset="1" stop-color="#7a1a5a"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect x="4" y="4" width="${w - 8}" height="${h - 8}" fill="none" stroke="#ffd24a" stroke-width="8"/>
    <line x1="0" y1="0" x2="${w}" y2="${h}" stroke="#4affd2" stroke-width="4"/>
    <line x1="${w}" y1="0" x2="0" y2="${h}" stroke="#4affd2" stroke-width="4"/>
    <text x="${w / 2}" y="52" font-size="40" font-family="monospace" fill="#ffffff" text-anchor="middle">TOP EDGE</text>
    <text x="${w / 2}" y="${h / 2 + 14}" font-size="40" font-family="monospace" fill="#ffffff" text-anchor="middle">CENTER</text>
    <text x="${w / 2}" y="${h - 24}" font-size="40" font-family="monospace" fill="#ffffff" text-anchor="middle">BOTTOM EDGE</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const dir = mkdtempSync(join(tmpdir(), "mv-image-testbed-"));
  const path = join(dir, "test.png");
  writeFileSync(path, png);
  return path;
}

const HEADER_ROWS = 1;
const FOOTER_ROWS = 1;
const VIEW_ROWS = ROWS - HEADER_ROWS - FOOTER_ROWS;

function makeLines(imagePath: string): NarrativeLine[] {
  const dm = (text: string): NarrativeLine => ({ kind: "dm", text });
  const lines: NarrativeLine[] = [];
  for (let i = 0; i < 13; i++) lines.push(dm(`${String(i).padStart(2, "0")} narrative narrative narrative line`));
  lines.push(dm("13 narrative narrative narrative line >>> IMG-ABOVE <<<"));
  lines.push({ kind: "separator", text: "" });
  lines.push({ kind: "image", text: imagePath, intent: "scene_snapshot" });
  lines.push(dm("15 narrative narrative narrative line >>> IMG-BELOW <<<"));
  for (let i = 16; i < 60; i++) lines.push(dm(`${String(i).padStart(2, "0")} narrative narrative narrative line`));
  return lines;
}

interface AppProps {
  imagePath: string;
}

function TestbedApp({ imagePath }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const [tick, setTick] = useState(0);
  const [ticking, setTicking] = useState(true);
  const [burst, setBurst] = useState(0);
  const [lines, setLines] = useState<NarrativeLine[]>(() => makeLines(imagePath));
  const insertedRef = useRef(0);

  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // Start at the top (NarrativeArea auto-scrolls to the bottom on mount).
  useEffect(() => {
    const t = setTimeout(() => narrativeRef.current?.scrollBy(-99999), 50);
    return () => clearTimeout(t);
  }, []);

  useInput((input, key) => {
    const sv = narrativeRef.current;
    if (input === "q") exit();
    else if (key.pageDown) sv?.scrollBy(scrollAmount(VIEW_ROWS));
    else if (key.pageUp) sv?.scrollBy(-scrollAmount(VIEW_ROWS));
    else if (input === "j" || key.downArrow) sv?.scrollBy(1);
    else if (input === "k" || key.upArrow) sv?.scrollBy(-1);
    else if (input === "g") sv?.scrollBy(-99999);
    else if (input === "G") sv?.scrollBy(99999);
    else if (input === "t") setTicking((v) => !v);
    else if (input === "x") setBurst((n) => n + 1);
    else if (input === "a") {
      // Insert ABOVE the image: shifts every subsequent line index (#781).
      const n = ++insertedRef.current;
      setLines((prev) => [{ kind: "dm", text: `-- inserted line ${n} --` }, ...prev]);
    }
  });

  const gameCtx = {
    graphicsCaps: caps,
    stdinFilterChain: null,
    usageStatus: null,
  } as unknown as GameContextValue;

  return (
    <OcclusionProvider>
      <GameProvider value={gameCtx}>
        <Box width={COLS} height={ROWS} flexDirection="column">
          <Text wrap="truncate" inverse>
            {` MV image testbed  tick=${tick}${ticking ? "" : " (paused)"}  burst=${burst}  lines=${lines.length}  [PgUp/PgDn j/k g/G a t x q] `}
          </Text>
          <NarrativeArea
            ref={narrativeRef}
            lines={lines}
            maxRows={VIEW_ROWS}
            width={COLS}
            viewportTop={HEADER_ROWS}
          />
          <Text wrap="truncate" dimColor>
            {` protocol=${PROTOCOL} cell=${CELL_W}x${CELL_H} view=${COLS}x${VIEW_ROWS} `}
          </Text>
        </Box>
      </GameProvider>
    </OcclusionProvider>
  );
}

async function main(): Promise<void> {
  // Fake a TTY over the pipes so Ink runs interactive + synchronized output.
  const stdout = process.stdout as NodeJS.WriteStream & { isTTY: boolean };
  stdout.isTTY = true;
  stdout.columns = COLS;
  stdout.rows = ROWS;
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY: boolean };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;

  setIncrementalRendering(true);
  installSyncWriteCombiner(process.stdout, compositePainters);

  const imagePath = await makeTestImage();
  const { waitUntilExit } = render(<TestbedApp imagePath={imagePath} />, {
    stdin,
    interactive: true,
    incrementalRendering: true,
    alternateScreen: false,
    patchConsole: false,
    exitOnCtrlC: true,
  });
  await waitUntilExit();
  process.exit(0);
}

void main();
