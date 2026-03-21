#!/usr/bin/env node
/**
 * Build script for Machine Violet distribution.
 *
 * Bundles with esbuild, creates a Node SEA executable, applies Windows
 * metadata via rcedit, and assembles asset directories alongside the binary.
 *
 * Usage:
 *   node scripts/build-dist.js                  # build for current platform
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

// --- Step 2: Node SEA ---
console.log("  Building Node SEA executable...");

const seaConfig = {
  main: "dist/bundle.js",
  output: `dist/${exeName}`,
  mainFormat: "module",
  disableExperimentalSEAWarning: true,
};
// Write sea-config to dist/ (temp file, cleaned up after build)
const seaConfigPath = join(DIST, "sea-config.json");
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

// Remove existing exe to avoid "file busy" errors
const exePath = join(DIST, exeName);
if (existsSync(exePath)) rmSync(exePath);

execSync(`node --build-sea dist/sea-config.json`, { stdio: "inherit", cwd: ROOT });
rmSync(seaConfigPath, { force: true });

// --- Step 3: Windows metadata via rcedit ---
if (isWindows) {
  const icoPath = join(ROOT, "assets", "machine-violet.ico");
  if (existsSync(icoPath)) {
    console.log("  Applying Windows metadata (rcedit)...");
    try {
      const { rcedit } = await import("rcedit");
      await rcedit(exePath, {
        icon: icoPath,
        "version-string": {
          ProductName: "Machine Violet",
          FileDescription: "AI Dungeon Master for tabletop RPGs",
          CompanyName: "Machine Violet",
          LegalCopyright: "MIT License",
        },
        // file-version must be numeric (X.Y.Z.W) — strip any prerelease suffix
        "file-version": `${version.replace(/-.*$/, "")}.0`,
        "product-version": version,
      });
    } catch (err) {
      console.warn(`  Warning: rcedit failed (${err instanceof Error ? err.message : String(err)}). Exe will lack icon/metadata.`);
    }
  }
}

// --- Step 4: Copy assets ---
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

// Clean up bundle (not needed alongside the exe)
rmSync(join(DIST, "bundle.js"), { force: true });

console.log(`\nDone! Distribution in ${DIST}/`);
console.log(`  Binary: ${exeName} (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  Version: ${version}`);
