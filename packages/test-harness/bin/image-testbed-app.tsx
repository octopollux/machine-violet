/**
 * Visual testbed app for the inline-image renderer (issue: spurious blanking +
 * misposition in the scroll viewport).
 *
 * A minimal, API-key-free stand-in for the game screen that exercises exactly
 * the layers the bugs live in: real Ink (fullscreen, incremental rendering),
 * the sync-write combiner + painter registry, ScrollView's virtual scroll, and
 * a real InlineImage with forced graphics caps. Drive it from a
 * graphics-capable terminal (or the xterm.js browser rig — see
 * image-testbed-server.mjs in the session scratchpad) and eyeball:
 *
 *  - the image renders between its marker lines (IMG-ABOVE / IMG-BELOW);
 *  - PgUp/PgDn/j/k scrolling keeps it glued to those markers, band-cropped at
 *    the viewport edges;
 *  - the 1Hz tick (idle-frame emulation) never blanks it;
 *  - `x` forces an unrelated re-render burst (the old blank trigger).
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
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import { InlineImage } from "../../client-ink/src/tui/image/InlineImage.js";
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
const IMAGE_AT = 14; // narrative line index the image sits at

interface AppProps {
  imagePath: string;
}

function TestbedApp({ imagePath }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const scrollRef = useRef<ScrollViewRef>(null);
  const [tick, setTick] = useState(0);
  const [ticking, setTicking] = useState(true);
  const [burst, setBurst] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  useInput((input, key) => {
    const sv = scrollRef.current;
    if (input === "q") exit();
    else if (key.pageDown) sv?.scrollBy(Math.floor(VIEW_ROWS / 2));
    else if (key.pageUp) sv?.scrollBy(-Math.floor(VIEW_ROWS / 2));
    else if (input === "j" || key.downArrow) sv?.scrollBy(1);
    else if (input === "k" || key.upArrow) sv?.scrollBy(-1);
    else if (input === "g") sv?.scrollTo(0);
    else if (input === "G") sv?.scrollToBottom();
    else if (input === "t") setTicking((v) => !v);
    else if (input === "x") setBurst((n) => n + 1);
  });

  const lines: React.ReactElement[] = [];
  for (let i = 0; i < 60; i++) {
    if (i === IMAGE_AT) {
      lines.push(
        <Box key="img" flexDirection="column" marginTop={1} marginBottom={1}>
          <InlineImage
            path={imagePath}
            maxCols={COLS}
            maxRows={Math.max(6, Math.round(VIEW_ROWS * 0.9))}
            viewportTop={HEADER_ROWS}
            viewportRows={VIEW_ROWS}
            graphicsCaps={caps}
          />
        </Box>,
      );
      continue;
    }
    const marker = i === IMAGE_AT - 1 ? " >>> IMG-ABOVE <<<" : i === IMAGE_AT + 1 ? " >>> IMG-BELOW <<<" : "";
    lines.push(
      <Text key={i} wrap="truncate">
        {`${String(i).padStart(2, "0")} ${"narrative ".repeat(3)}line${marker}`}
      </Text>,
    );
  }

  return (
    <OcclusionProvider>
      <Box width={COLS} height={ROWS} flexDirection="column">
        <Text wrap="truncate" inverse>
          {` MV image testbed  tick=${tick}${ticking ? "" : " (paused)"}  burst=${burst}  offset=${offset}  [PgUp/PgDn j/k g/G t x q] `}
        </Text>
        <Box height={VIEW_ROWS} flexDirection="column">
          <ScrollView ref={scrollRef} onScroll={setOffset}>
            {lines}
          </ScrollView>
        </Box>
        <Text wrap="truncate" dimColor>
          {` protocol=${PROTOCOL} cell=${CELL_W}x${CELL_H} view=${COLS}x${VIEW_ROWS} `}
        </Text>
      </Box>
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
