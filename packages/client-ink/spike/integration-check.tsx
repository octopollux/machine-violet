/**
 * THROWAWAY integration check for #552 — exercises the REAL production
 * components (not spike code): InlineImage, OcclusionProvider/useRegisterOcclusion,
 * installSyncWriteCombiner + compositePainters, detectGraphicsCapabilities,
 * and whichever driver the terminal selects (sixel / iTerm2 / kitty).
 *
 * Slides a real InlineImage through a fixed viewport framed by TOP/INPUT
 * boundaries; `o` mounts a real occluder (registers a row-span) over the
 * bottom of the viewport. Confirms, against the shipping code path:
 *   - steady, flicker-free paint (combiner splice inside the sync block)
 *   - clean vertical crop at both boundaries
 *   - occlusion gate: image hides only when its band overlaps the occluder
 *     (kitty: the placement is deleted; sixel/iTerm2: pixels are overwritten)
 *
 * The header shows the detected `proto=` so you can confirm which driver ran.
 *
 *   ↑/↓ slide   o toggle occluder   q quit
 *
 * Run:  npx tsx packages/client-ink/spike/integration-check.tsx
 *   - sixel  → Windows Terminal, foot, recent xterm
 *   - kitty  → kitty, Ghostty, WezTerm (kitty wins when multiple are supported)
 *   - iTerm2 → iTerm2 (and WezTerm if kitty is somehow unavailable)
 * Delete spike/ once #552 lands.
 */
import React, { useRef, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { installSyncWriteCombiner } from "../src/tui/hooks/syncWriteCombiner.js";
import { compositePainters } from "../src/tui/image/painterRegistry.js";
import { detectGraphicsCapabilities, pickProtocol, sixelPaletteSize, type GraphicsCapabilities } from "../src/tui/image/capabilities.js";
import { InlineImage } from "../src/tui/image/InlineImage.js";
import { OcclusionProvider, useRegisterOcclusion } from "../src/tui/image/occlusion.js";

const VIEW_ROWS = 18;
const HEADER_ROWS = 3; // title + help + TOP boundary → viewport starts at row 3
// OCC.top is an ABSOLUTE screen row (occlusion spans are absolute, like prod
// modals). The viewport starts at HEADER_ROWS, so this sits 12 rows into it.
const OCC = { top: HEADER_ROWS + 12, rows: 6 };

// Must be rendered as a root-level absolute overlay so its marginTop is measured
// from the screen top — i.e. the rendered row equals the registered row. (A real
// modal does exactly this: CenteredModal registers top:topMargin and renders at
// marginTop:topMargin from a root position:absolute box.) Nesting it inside the
// viewport box would offset the visual position by HEADER_ROWS from what it
// registers, blanking the image early.
function Occluder(): React.ReactElement {
  useRegisterOcclusion({ top: OCC.top, rows: OCC.rows });
  return (
    <Box position="absolute" marginTop={OCC.top} width={40} height={OCC.rows}
         flexDirection="column" justifyContent="center" alignItems="center">
      <Text backgroundColor="blue" color="white"> MODAL (real occluder rows {OCC.top}–{OCC.top + OCC.rows}) </Text>
      <Text backgroundColor="blue" color="white"> slide image clear of these rows → it stays </Text>
    </Box>
  );
}

function Filler({ label, n }: { label: string; n: number }): React.ReactElement {
  return <>{Array.from({ length: n }, (_, i) => <Text key={i} dimColor>{label} line {i + 1}</Text>)}</>;
}

function App({ caps, path, cols, rows }: { caps: GraphicsCapabilities; path: string; cols: number; rows: number }): React.ReactElement {
  const { exit } = useApp();
  const scrollRef = useRef<ScrollViewRef>(null);
  const [occ, setOcc] = useState(false);
  const [, force] = useState(0);
  // ScrollView's scrollBy updates its internal offset but doesn't re-render us;
  // InlineImage re-measures only on re-render. Production's NarrativeArea
  // re-renders on scroll via setLinesBelow — mirror that with onScroll here.
  const onScroll = () => force((x) => x + 1);
  // Real ScrollView reproduces production (marginTop:-scrollOffset), so the
  // image slot genuinely moves above the viewport top → top-clipping works.
  useInput((input, key) => {
    if (input === "q") return exit();
    if (input === "o") setOcc((v) => !v);
    if (key.upArrow) scrollRef.current?.scrollBy(-1);
    if (key.downArrow) scrollRef.current?.scrollBy(1);
  });
  return (
    <OcclusionProvider>
      <Box flexDirection="column">
        <Text bold>#552 integration-check. proto={pickProtocol(caps) ?? "NONE"} cell={caps.cellPixels ? `${caps.cellPixels.width}x${caps.cellPixels.height}` : "?"} registers={caps.sixelColorRegisters ?? "unreported"} palette={sixelPaletteSize(caps)}</Text>
        <Text dimColor>↑/↓ scroll   o occluder({occ ? "ON" : "off"})   q quit</Text>
        <Text color="magenta">{"━".repeat(cols)} TOP BOUNDARY</Text>
        <Box height={VIEW_ROWS} flexDirection="column">
          <ScrollView ref={scrollRef} onScroll={onScroll}>
            <Filler label="above" n={6} />
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <InlineImage path={path} cols={cols} rows={rows} viewportTop={HEADER_ROWS} viewportRows={VIEW_ROWS} graphicsCaps={caps} />
            </Box>
            <Filler label="below" n={12} />
          </ScrollView>
        </Box>
        <Text color="magenta">{"━".repeat(cols)} INPUT BOUNDARY (nothing below)</Text>
        <Text color="greenBright">{"> "}input line</Text>
        {/* Root-level absolute overlay: rendered row == registered row. */}
        {occ && <Occluder />}
      </Box>
    </OcclusionProvider>
  );
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY) { console.error("Run in Windows Terminal, not piped."); process.exit(0); }
  installSyncWriteCombiner(process.stdout, compositePainters);
  // Production (start-client.ts) enables raw mode via installRawModeGuard
  // BEFORE probing, so the terminal's escape-sequence replies land on stdin
  // instead of being echoed. This standalone probe must do the same.
  process.stdin.setRawMode?.(true);
  const caps = await detectGraphicsCapabilities(process.stdin, process.stdout);
  // Build a recognizable gridded/striped sample PNG.
  const w = 480, h = 270;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const grid = x % 40 === 0 || y % 30 === 0;
    raw[i] = grid ? 255 : Math.floor((x / w) * 255);
    raw[i + 1] = grid ? 255 : Math.floor((y / h) * 255);
    raw[i + 2] = grid ? 0 : 128;
  }
  const path = join(tmpdir(), "mv-552-sample.png");
  writeFileSync(path, await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  const cols = Math.max(20, Math.min(44, (process.stdout.columns ?? 80) - 6));
  const rows = Math.max(6, Math.round((cols * 9) / 32));
  const { waitUntilExit } = render(<App caps={caps} path={path} cols={cols} rows={rows} />);
  await waitUntilExit();
}

void main();
