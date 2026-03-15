#!/usr/bin/env bun
/**
 * Build script for Machine Violet distribution.
 *
 * Compiles the app with `bun build --compile` and assembles
 * asset directories alongside the binary.
 *
 * Usage:
 *   bun scripts/build-dist.ts                  # build for current platform
 *   bun scripts/build-dist.ts --target=linux   # cross-compile
 */

import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version: string = pkg.version;

// Parse --target flag
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg?.split("=")[1]; // e.g. "linux", "windows", "darwin"

// Platform-specific binary name
const isWindows = target
  ? target.startsWith("windows") || target.startsWith("win")
  : process.platform === "win32";
const exeName = isWindows ? "machine-violet.exe" : "machine-violet";

console.log(`Building Machine Violet v${version}...`);

// Clean and create dist directory
mkdirSync(DIST, { recursive: true });

// Compile with Bun
const targetFlag = target ? ` --target=bun-${target}-x64` : "";
const cmd = [
  "bun build --compile",
  `--outfile ${join(DIST, exeName)}`,
  `--define "process.env.MV_VERSION='${version}'"`,
  isWindows ? `--windows-icon=${join(ROOT, "assets", "machine-violet.ico")}` : "",
  isWindows ? `--windows-title="Machine Violet"` : "",
  isWindows ? `--windows-description="AI Dungeon Master for tabletop RPGs"` : "",
  isWindows ? `--windows-version=${version}.0` : "",
  targetFlag,
  join(ROOT, "src/index.tsx"),
].filter(Boolean).join(" ");

console.log(`  Compiling...`);
execSync(cmd, { stdio: "inherit", cwd: ROOT });

// Copy asset directories
const assets: Array<{ src: string; dest: string }> = [
  { src: "src/prompts", dest: "prompts" },
  { src: "src/tui/themes/assets", dest: "themes" },
  { src: "systems", dest: "systems" },
];

for (const { src, dest } of assets) {
  const srcDir = join(ROOT, src);
  const destDir = join(DIST, dest);
  console.log(`  Copying ${dest}/...`);
  cpSync(srcDir, destDir, { recursive: true });
}

// Copy license (if present)
const licensePath = join(ROOT, "LICENSE");
if (existsSync(licensePath)) {
  cpSync(licensePath, join(DIST, "LICENSE"));
}

// Write version file (for update checker)
writeFileSync(join(DIST, "version.json"), JSON.stringify({ version }, null, 2));

console.log(`\nDone! Distribution in ${DIST}/`);
console.log(`  Binary: ${exeName}`);
console.log(`  Version: ${version}`);
