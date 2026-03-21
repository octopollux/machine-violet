#!/usr/bin/env node
/**
 * Build script for Machine Violet distribution.
 *
 * Bundles with esbuild, creates a Node SEA executable via the multi-step
 * workflow (copy → strip signature → generate blob → inject), applies
 * Windows metadata via rcedit, and assembles asset directories alongside
 * the binary.
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
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";
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
const blobPath = join(DIST, "sea-prep.blob");

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

// --- Step 2: Node SEA (multi-step for signing compatibility) ---
//
// --build-sea produces a PE binary whose headers confuse signtool (the
// injected blob invalidates the checksum/signature table). The traditional
// workflow avoids this by stripping the Authenticode signature from a clean
// copy of node.exe BEFORE injection, so signtool never sees a corrupt state.
//
//   a) Generate the blob
//   b) Copy node.exe → dist/machine-violet.exe
//   c) Strip Microsoft's Authenticode signature (Windows only)
//   d) Inject the blob with postject

console.log("  Generating SEA blob...");

const seaConfig = {
  main: "dist/bundle.js",
  output: "dist/sea-prep.blob",
  mainFormat: "module",
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = join(DIST, "sea-config.json");
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

execSync(`node --experimental-sea-config dist/sea-config.json`, {
  stdio: "inherit",
  cwd: ROOT,
});
rmSync(seaConfigPath, { force: true });

// Copy node binary
console.log("  Copying node binary...");
if (existsSync(exePath)) rmSync(exePath);
cpSync(process.execPath, exePath);

// Strip Authenticode signature on Windows before injection.
// node.exe ships pre-signed by Microsoft. If we inject the blob first,
// the stale signature makes the PE unsignable (0x800700C1).
if (isWindows) {
  const signtool = findSigntool();
  if (signtool) {
    try {
      execFileSync(signtool, ["remove", "/s", exePath], { stdio: "inherit" });
      console.log("  Stripped Authenticode signature.");
    } catch {
      console.warn("  Warning: signtool remove failed — signing may fail later.");
    }
  } else {
    console.warn("  Warning: signtool not found — skipping signature strip.");
  }
}

// Set Windows exe icon via rcedit (after sig strip, before blob injection).
// The PE is clean and unsigned at this point so rcedit won't hang.
// postject only touches the blob section — icon resources survive injection.
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

// Inject blob with postject
console.log("  Injecting SEA blob...");
const postjectBin = join(ROOT, "node_modules", ".bin", isWindows ? "postject.cmd" : "postject");
execSync(
  `"${postjectBin}" "${exePath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: "inherit", cwd: ROOT },
);

// Clean up blob
rmSync(blobPath, { force: true });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find signtool.exe in the Windows SDK. Returns path or null. */
function findSigntool() {
  // Try PATH first
  try {
    execFileSync("signtool", ["/?"], { stdio: "ignore" });
    return "signtool";
  } catch { /* not on PATH */ }

  // Search Windows SDK
  const sdkBin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(sdkBin)) return null;
  try {
    const versions = readdirSync(sdkBin)
      .filter((d) => /^10\.\d/.test(d))
      .sort()
      .reverse();
    for (const ver of versions) {
      const candidate = join(sdkBin, ver, "x64", "signtool.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}
