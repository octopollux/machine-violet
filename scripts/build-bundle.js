#!/usr/bin/env node
/**
 * Bundle Machine Violet into a single JS file for Node SEA injection.
 *
 * Usage:
 *   node scripts/build-bundle.js                  # bundle to dist/bundle.js
 *   node scripts/build-bundle.js --minify         # minified bundle
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version = pkg.version;
const minify = process.argv.includes("--minify");

await build({
  entryPoints: [join(ROOT, "src/index.tsx")],
  bundle: true,
  outfile: join(ROOT, "dist/bundle.js"),
  platform: "node",
  target: "node25",
  format: "esm",
  jsx: "automatic",
  // Bundle everything (npm deps included). Only node: builtins stay external.
  external: ["node:*"],
  define: {
    "process.env.MV_VERSION": JSON.stringify(version),
  },
  banner: {
    // Provide require() for any CJS interop needed at runtime
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
    ].join("\n"),
  },
  minify,
  sourcemap: false,
});

console.log(`Bundled dist/bundle.js (v${version}${minify ? ", minified" : ""})`);
