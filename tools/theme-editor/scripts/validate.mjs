#!/usr/bin/env node
/**
 * Validate every .theme and .player-frame in packages/client-ink/src/tui/themes/assets/.
 * Parses + resolves each so we surface broken art, bad config keys, and unknown
 * presets/gradients/harmonies before the TUI tries to render them.
 *
 * Usage: node --import tsx/esm tools/theme-editor/scripts/validate.mjs
 * Exit code is the number of files that failed.
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const assetsDir = resolve(repoRoot, "packages/client-ink/src/tui/themes/assets");

// Windows-safe dynamic import: must convert path to file:// URL.
const loaderUrl = pathToFileURL(
  resolve(repoRoot, "packages/client-ink/src/tui/themes/loader.ts"),
).href;
const resolverUrl = pathToFileURL(
  resolve(repoRoot, "packages/client-ink/src/tui/themes/resolver.ts"),
).href;

const { loadBuiltinTheme, loadBuiltinPlayerFrame, loadThemeDefinition } = await import(loaderUrl);
const { resolveTheme } = await import(resolverUrl);

const themes = readdirSync(assetsDir)
  .filter((f) => f.endsWith(".theme"))
  .map((f) => f.replace(/\.theme$/, ""))
  .sort();
const frames = readdirSync(assetsDir)
  .filter((f) => f.endsWith(".player-frame"))
  .map((f) => f.replace(/\.player-frame$/, ""))
  .sort();

let failures = 0;
const VARIANTS = ["exploration", "combat", "ooc", "levelup", "dev"];

function formatError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

console.log(`\n=== Themes (${themes.length}) ===`);
for (const name of themes) {
  try {
    const asset = loadBuiltinTheme(name);
    const def = loadThemeDefinition(name);
    for (const v of VARIANTS) {
      resolveTheme(def, v, "#8a6cff");
    }
    const cw = asset.components.edge_top.width;
    const ch = asset.components.edge_left.height;
    const tags = asset.genreTags.join(",") || "(none)";
    console.log(`  ok   ${name.padEnd(28)} h=${asset.height} tile=${cw}x${ch} tags=${tags}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${formatError(err)}`);
  }
}

console.log(`\n=== Player frames (${frames.length}) ===`);
for (const name of frames) {
  try {
    const frame = loadBuiltinPlayerFrame(name);
    const cw = frame.components.corner_tl.width;
    console.log(`  ok   ${name.padEnd(28)} corner_tl=${cw}w`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${formatError(err)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed validation`);
  // POSIX exit codes are 0-255; clamp so a triple-digit failure count
  // doesn't wrap and look like success.
  process.exit(Math.min(failures, 255));
} else {
  console.log(`\nAll ${themes.length} themes + ${frames.length} frames validated cleanly.`);
}
