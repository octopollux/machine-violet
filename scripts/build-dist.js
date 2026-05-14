#!/usr/bin/env node
/**
 * Build script for Machine Violet distribution.
 *
 * Bundles with esbuild, creates a Node SEA executable, applies Windows
 * metadata via rcedit, and assembles asset directories alongside the binary.
 *
 * SEA creation is platform-split: macOS/Linux use --build-sea (postject
 * corrupts Node 25's Mach-O layout); Windows uses the postject workflow
 * (--build-sea breaks Velopack/Authenticode signing).
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
const exeName = isWindows ? "MachineViolet.exe" : "MachineViolet";
const exePath = join(DIST, exeName);

console.log(`Building Machine Violet v${version}...`);

// Clean and create dist directory
mkdirSync(DIST, { recursive: true });

// --- Step 1: esbuild bundle ---
console.log("  Bundling with esbuild...");

await build({
  entryPoints: [join(ROOT, "scripts/launcher.ts")],
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
//
// Two paths:
//   macOS/Linux — Node 25's --build-sea produces a correct binary in one step.
//                 postject 1.0.0-alpha.6 corrupts Node 25's Mach-O layout,
//                 causing an immediate segfault on ARM64.
//   Windows    — The battle-tested postject workflow: generate blob → copy
//                node.exe → strip Authenticode sig → set icon → inject blob.
//                --build-sea produces a PE whose signature state breaks
//                Velopack/signtool downstream.

const seaConfigPath = join(DIST, "sea-config.json");

if (isWindows) {
  // --- Windows: postject workflow ---
  console.log("  Generating SEA blob...");

  const blobPath = join(DIST, "sea-prep.blob");
  const seaConfig = {
    main: "dist/bundle.js",
    output: "dist/sea-prep.blob",
    mainFormat: "module",
    disableExperimentalSEAWarning: true,
  };
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

  // Strip Authenticode signature before injection.
  // node.exe ships pre-signed by Microsoft. If we inject the blob first,
  // the stale signature makes the PE unsignable (0x800700C1).
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

  // Set exe icon (after sig strip, before blob injection).
  // The PE is clean and unsigned at this point so rcedit won't hang.
  // postject only touches the blob section — icon resources survive injection.
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

  // Inject blob with postject
  console.log("  Injecting SEA blob...");
  const postjectBin = join(ROOT, "node_modules", ".bin", "postject.cmd");
  execSync(
    `"${postjectBin}" "${exePath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { stdio: "inherit", cwd: ROOT },
  );

  rmSync(blobPath, { force: true });
} else {
  // --- macOS/Linux: --build-sea ---
  console.log("  Building single executable...");

  const seaConfig = {
    main: "dist/bundle.js",
    output: `dist/${exeName}`,
    mainFormat: "module",
    disableExperimentalSEAWarning: true,
  };
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  if (existsSync(exePath)) rmSync(exePath);
  execSync(`node --build-sea=dist/sea-config.json`, {
    stdio: "inherit",
    cwd: ROOT,
  });
  rmSync(seaConfigPath, { force: true });

  // Re-sign on macOS — --build-sea inherits the ad-hoc signature from the
  // source node binary, but the injected blob invalidates it. Apple Silicon
  // kills binaries with broken signatures.
  if (process.platform === "darwin") {
    console.log("  Re-signing binary (ad-hoc)...");
    execSync(`codesign --sign - --force "${exePath}"`, { stdio: "inherit" });
  }
}

// Clean up intermediate bundle
rmSync(join(DIST, "bundle.js"), { force: true });

// --- Step 3: Copy assets ---
const assets = [
  { src: "packages/engine/src/prompts", dest: "prompts" },
  { src: "packages/client-ink/src/tui/themes/assets", dest: "themes" },
  { src: "systems", dest: "systems" },
  { src: "worlds", dest: "worlds", filter: /\.mvworld$/ },
  { src: "packages/engine/src/config", dest: "config", filter: /\.json$/ },
  // Keep upstream LICENSE/README alongside JSON assets so dataset
  // attribution travels with the compiled binary, not just the source tree.
  { src: "packages/engine/src/assets", dest: "assets", filter: /(?:\.json$|(?:^|[\\/])(?:LICENSE|README\.md)$)/ },
];

for (const { src, dest, filter } of assets) {
  const srcDir = join(ROOT, src);
  const destDir = join(DIST, dest);
  console.log(`  Copying ${dest}/...`);
  if (filter) {
    cpSync(srcDir, destDir, { recursive: true, filter: (s) => statSync(s).isDirectory() || filter.test(s) });
  } else {
    cpSync(srcDir, destDir, { recursive: true });
  }
}

// --- Step 3.5: Vendor the `@openai/codex` runtime ---
//
// The openai-chatgpt provider drives `codex app-server` as a subprocess.
// The codex CLI is a tiny Node wrapper (bin/codex.js) plus a platform-
// specific Rust binary published as separate optional dependencies
// (@openai/codex-{platform}-{arch}). Neither survives the esbuild bundle
// nor the SEA injection: the Rust binary is opaque and the wrapper does
// runtime `require.resolve` against node_modules that won't exist next to
// the SEA. So we copy both into `dist/codex/` and have `binary.ts` look
// there first (see its colocated-path resolution).
//
// Layout matches what codex.js expects when its `require.resolve` of the
// optional-dep package fails (bin/codex.js:92):
//   dist/codex/bin/codex.js
//   dist/codex/package.json
//   dist/codex/vendor/{triple}/codex/codex[.exe]
//   dist/codex/vendor/{triple}/path/rg[.exe]
//
// Each build runs on its own platform's runner (windows-latest,
// macos-latest, ubuntu-latest), so `npm ci` only installs the matching
// platform package — we copy whatever's present rather than enumerate.
console.log("  Vendoring codex runtime...");
vendorCodex(ROOT, DIST);

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

/**
 * Copy the platform-matching `@openai/codex` runtime into `dist/codex/`.
 *
 * The codex.js wrapper resolves its native binary in two ways:
 *   (a) `require.resolve("@openai/codex-{platform}-{arch}/package.json")` —
 *       works only when the optional-dep package sits in node_modules
 *       next to the wrapper. Inside our SEA build, no such node_modules
 *       exists, so this branch always fails at runtime.
 *   (b) Falls back to `path.join(__dirname, "..", "vendor", triple,
 *       "codex", "codex[.exe]")` — works if we colocate the vendor tree
 *       with the wrapper. This is the path we feed.
 *
 * Per-platform mapping mirrors `bin/codex.js` PLATFORM_PACKAGE_BY_TARGET.
 * Throws when run on an unsupported platform/arch combination (no point
 * cutting a Machine Violet build that can't run codex).
 */
function vendorCodex(rootDir, distDir) {
  const { platform, arch } = process;
  const map = {
    "win32:x64":   { pkg: "@openai/codex-win32-x64",   triple: "x86_64-pc-windows-msvc" },
    "win32:arm64": { pkg: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
    "darwin:x64":  { pkg: "@openai/codex-darwin-x64",  triple: "x86_64-apple-darwin" },
    "darwin:arm64":{ pkg: "@openai/codex-darwin-arm64",triple: "aarch64-apple-darwin" },
    "linux:x64":   { pkg: "@openai/codex-linux-x64",   triple: "x86_64-unknown-linux-musl" },
    "linux:arm64": { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
  };
  const key = `${platform}:${arch}`;
  const entry = map[key];
  if (!entry) {
    throw new Error(`vendorCodex: unsupported platform ${key}`);
  }

  const wrapperRoot = join(rootDir, "node_modules", "@openai", "codex");
  const platformRoot = join(rootDir, "node_modules", "@openai", entry.pkg.split("/")[1]);

  if (!existsSync(wrapperRoot)) {
    throw new Error(`vendorCodex: @openai/codex not installed at ${wrapperRoot}`);
  }
  if (!existsSync(platformRoot)) {
    throw new Error(
      `vendorCodex: ${entry.pkg} not installed at ${platformRoot}. ` +
      `Optional deps may have been skipped — re-run \`npm install\` without --no-optional.`,
    );
  }

  const destRoot = join(distDir, "codex");
  // Copy wrapper bin + package.json. We don't need anything else under it.
  mkdirSync(join(destRoot, "bin"), { recursive: true });
  cpSync(join(wrapperRoot, "bin"), join(destRoot, "bin"), { recursive: true });
  cpSync(join(wrapperRoot, "package.json"), join(destRoot, "package.json"));

  // Copy the platform vendor tree. The triple subdir contains codex/ and
  // path/ (ripgrep), both of which the Rust binary expects to find as
  // siblings — strip nothing, copy the lot.
  const srcVendor = join(platformRoot, "vendor", entry.triple);
  const destVendor = join(destRoot, "vendor", entry.triple);
  cpSync(srcVendor, destVendor, { recursive: true });

  // Log a size summary so build output makes the ~250MB Rust binary visible.
  const bytes = dirSizeBytes(destRoot);
  console.log(`    codex/ vendored: ${(bytes / 1024 / 1024).toFixed(1)} MB (${entry.triple})`);
}

/** Recursive byte-count for a directory tree. */
function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

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

