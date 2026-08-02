/**
 * Bench for the inline-image band encoders (issue #780).
 *
 * The painter re-encodes the visible band synchronously inside the frame's
 * sync-write injection whenever the band identity changes — i.e. on every
 * scroll step with an image on screen. This bench measures that cost on REAL
 * repo art (the ImageStyleExample gallery) at production band geometry, per
 * driver, so encoder changes can be judged on numbers.
 *
 * Run: node --import tsx/esm packages/test-harness/bin/image-encode-bench.ts
 *   [--images N] [--cols 100] [--rows 25] [--cellw 10] [--cellh 20]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { selectDriver } from "../../client-ink/src/tui/image/drivers/index.js";

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const N_IMAGES = arg("images", 5);
const COLS = arg("cols", 100);
const ROWS = arg("rows", 25);
const CELL_W = arg("cellw", 10);
const CELL_H = arg("cellh", 20);
const W = COLS * CELL_W;
const H = ROWS * CELL_H;

const GALLERY = join(
  import.meta.dirname, "..", "..", "engine", "src", "prompts", "include", "ImageStyleExample",
);

function stats(samples: number[]): string {
  const s = [...samples].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const max = s[s.length - 1];
  return `med ${med.toFixed(1)}ms max ${max.toFixed(1)}ms`;
}

async function main(): Promise<void> {
  const pngs = readdirSync(GALLERY).filter((f) => f.endsWith(".example.png")).slice(0, N_IMAGES);
  console.log(`band geometry ${W}x${H}px (${COLS}x${ROWS} cells @ ${CELL_W}x${CELL_H}) — ${pngs.length} gallery images\n`);

  for (const proto of ["sixel", "iterm2"] as const) {
    const prepTimes: number[] = [];
    const fullTimes: number[] = [];
    const bandTimes: number[] = [];
    const scrollTimes: number[] = []; // successive 1-row-shifted bands, like a scroll gesture
    let fullBytes = 0;
    let bandBytes = 0;

    for (const name of pngs) {
      const { data } = await sharp(join(GALLERY, name))
        .resize(W, H, { fit: "cover" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const driver = selectDriver(proto);
      const t0 = performance.now();
      const img = driver.prepare(data, W, H, () => undefined, 1024, { width: CELL_W, height: CELL_H });
      prepTimes.push(performance.now() - t0);
      // Let any background warm-up (sixel per-phase slice caches) finish so the
      // steady-state numbers below measure the warm path — the painter's cold
      // fallback is the pre-#780 direct encode.
      await img.whenWarm?.();

      const t1 = performance.now();
      const full = img.encodeBand(0, H);
      fullTimes.push(performance.now() - t1);
      fullBytes = Math.max(fullBytes, full.length);

      const t2 = performance.now();
      const band = img.encodeBand(Math.floor(H / 2), 10 * CELL_H);
      bandTimes.push(performance.now() - t2);
      bandBytes = Math.max(bandBytes, band.length);

      // Scroll gesture: 10 successive bands each shifted one row (cellH px).
      for (let step = 0; step < 10; step++) {
        const top = step * CELL_H;
        const rows = Math.min(15 * CELL_H, H - top);
        const t3 = performance.now();
        img.encodeBand(top, rows);
        scrollTimes.push(performance.now() - t3);
      }
      img.dispose();
    }

    console.log(`${proto}:`);
    console.log(`  prepare     ${stats(prepTimes)}`);
    console.log(`  full band   ${stats(fullTimes)}  (${(fullBytes / 1024).toFixed(0)}KB max)`);
    console.log(`  10-row band ${stats(bandTimes)}  (${(bandBytes / 1024).toFixed(0)}KB max)`);
    console.log(`  scroll step ${stats(scrollTimes)}  (15-row bands, 1-row shifts)\n`);
  }
}

void main();
