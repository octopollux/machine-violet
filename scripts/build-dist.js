#!/usr/bin/env node
/**
 * Build script for Machine Violet distribution.
 *
 * Bundles with esbuild, creates a Node SEA executable via --build-sea,
 * applies Windows metadata via rcedit, and assembles asset directories
 * alongside the binary.
 *
 * Usage:
 *   node scripts/build-dist.js                          # build for current platform
 *   node scripts/build-dist.js --version=1.0.0-nightly  # override version
 */

import { build } from "esbuild";
import {
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

// Allow version override via --version=X.Y.Z (used by CI for nightly versions)
const versionArg = process.argv.find((a) => a.startsWith("--version="));
const version = versionArg ? versionArg.split("=")[1] : pkg.version;

const isWindows = process.platform === "win32";
const exeName = isWindows ? "machine-violet.exe" : "machine-violet";
const exePath = join(DIST, exeName);

console.log(`Building Machine Violet v${version}...`);

// Clean and create dist directory
mkdirSync(DIST, { recursive: true });

// --- Step 1: esbuild bundle ---
console.log("  Bundling with esbuild...");

await build({
  entryPoints: [join(ROOT, "src/index.tsx")],
  bundle: true,
  outfile: join(DIST, "bundle.js"),
  platform: "node",
  target: "node25",
  format: "esm",
  jsx: "automatic",
  external: ["node:*"],
  define: {
    "process.env.MV_VERSION": JSON.stringify(version),
  },
  banner: {
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
    ].join("\n"),
  },
  minify: false,
  sourcemap: false,
});

// --- Step 2: Node SEA via --build-sea ---
//
// Node 25's --build-sea produces a complete single-executable binary in one
// step (copies node, injects blob, sets fuse). This replaces the old
// multi-step postject workflow which broke on Node 25's Mach-O layout,
// causing segfaults on macOS ARM64.

console.log("  Building single executable...");

const seaConfig = {
  main: "dist/bundle.js",
  output: `dist/${exeName}`,
  mainFormat: "module",
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = join(DIST, "sea-config.json");
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

if (existsSync(exePath)) rmSync(exePath);
execSync(`node --build-sea=dist/sea-config.json`, {
  stdio: "inherit",
  cwd: ROOT,
});
rmSync(seaConfigPath, { force: true });

// Set Windows exe icon via rcedit (after SEA build, before Velopack signing).
if (isWindows) {
  const icoPath = join(ROOT, "assets", "machine-violet.ico");
  if (existsSync(icoPath)) {
    console.log("  Setting exe icon (rcedit)...");
    try {
      const { rcedit } = await import("rcedit");
      await rcedit(exePath, { icon: icoPath });
    } catch (err) {
      console.warn(`  Warning: rcedit failed (${err instanceof Error ? err.message : String(err)}). Exe will have Node icon.`);
    }
  }
}

// Re-sign on macOS — --build-sea inherits the ad-hoc signature from the
// source node binary, but the injected blob invalidates it. Apple Silicon
// kills binaries with broken signatures.
if (process.platform === "darwin") {
  console.log("  Re-signing binary (ad-hoc)...");
  execSync(`codesign --sign - --force "${exePath}"`, { stdio: "inherit" });
}

// Clean up intermediate bundle
rmSync(join(DIST, "bundle.js"), { force: true });

// --- Step 3: Copy assets ---
const assets = [
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

// Copy license
const licensePath = join(ROOT, "LICENSE");
if (existsSync(licensePath)) {
  cpSync(licensePath, join(DIST, "LICENSE"));
}

// Version file
writeFileSync(join(DIST, "version.json"), JSON.stringify({ version }, null, 2));

console.log(`\nDone! Distribution in ${DIST}/`);
console.log(`  Binary: ${exeName} (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  Version: ${version}`);

