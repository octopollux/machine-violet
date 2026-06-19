#!/usr/bin/env node
/**
 * Image-style sampling probe.
 *
 * Idea-work scratchpad for growing the `.mvstyle` style catalog. Renders ONE
 * fixed scene (the opening establishing shot of "Ghosts of Station Proxima")
 * through a `--style` directive supplied on the command line, the same way the
 * DM does: scene/subject description first, then the style line appended
 * verbatim LAST (gpt-image-2 adheres better when style guidance comes last).
 *
 * Every style line MUST carry a caption directive — that's a catalog rule.
 *
 * Drives `OpenAIChatGptProvider.generateImage` directly against the live
 * ChatGPT connection in the dev config dir (connections.json at the repo root).
 * Real ChatGPT-plan spend; each render is multi-minute. One render per run.
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/style-probe.ts \
 *     --style="<full style line, ends with a caption directive>" \
 *     [--label=<slug>] [--effort=draft|standard|quality|showcase] \
 *     [--aspect=portrait|landscape|square] [--connection=<id>]
 *
 * Output PNG: .style-samples/<label>.png (under the repo root).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createOpenAIChatGptProvider } from "../../engine/src/providers/index.js";
import { createConnectionTokenStore } from "../../engine/src/providers/openai-chatgpt/index.js";
import type { ImageAspect, ImageEffort } from "../../engine/src/providers/types.js";
import { loadConnectionStore } from "../../engine/src/config/connections.js";
import { initEngineLog } from "../../engine/src/context/engine-log.js";
import { REPO_ROOT, findConfigDir } from "../src/launch-env.js";

// ---------------------------------------------------------------------------
// The scene — opening establishing shot of The Cenotaph (scene 1, "Two Return").
// Subject / composition / lighting / mood first; the style line is appended last
// by the probe. Kept deliberately dense: an impossible alien station gives the
// model organized work to do, the antidote to the "cram detail everywhere" tic.
// ---------------------------------------------------------------------------

const SCENE =
  "Inside the cramped cockpit of a small shuttle, the xenotechnologist Xera is seen from " +
  "behind and slightly above at the controls — leaning toward the canopy, her insulating " +
  "gloves on the console — a small human figure in the lower foreground. Through the " +
  "forward glass ahead of her hangs a derelict alien space station called The Cenotaph, in " +
  "deep space near a dim red star. Six dark modules of matte black alloy turn slowly around " +
  "a single black central spine; each module is built from impossible, non-Euclidean angles " +
  "that do not quite agree with one another — geometry that makes the eye revise itself. The " +
  "structure reads as kilometers long and far too large for the foreground. Between two of " +
  "the modules, where there should be empty linkage truss, hangs a seventh shape: narrow, " +
  "unlit, present the way a held breath is present. A weak ring of amber docking lights " +
  "flickers along one module, half of them dead. Cold hard starlight rakes across the alloy; " +
  "the lit cockpit instruments glow teal and amber around Xera's silhouette. Wide cinematic " +
  "establishing shot, the human figure small against the vast wrong architecture. The mood " +
  "is vast, lonely, reverent, and quietly wrong.";

// Default character reference — Xera's portrait from the Cenotaph campaign. Baked in
// so every style try conditions on the PC the same way the DM does via
// reference_characters / loadCharacterReferences: full-res PNG, label = the name the
// prompt uses. Override with --reference / --reference-label, or disable with --no-reference.
const DEFAULT_REFERENCE_PATH =
  "C:\\Users\\quant\\Documents\\.machine-violet\\campaigns\\ghosts-of-station-proxima-the-cenotaph\\characters\\xera-portrait.png";
const DEFAULT_REFERENCE_LABEL = "Xera";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const VALID_EFFORTS: ImageEffort[] = ["draft", "standard", "quality", "showcase"];
const VALID_ASPECTS: ImageAspect[] = ["portrait", "landscape", "square"];

interface Args {
  style: string;
  label: string;
  effort: ImageEffort;
  aspect: ImageAspect;
  connectionId?: string;
  /** Scene/subject text; defaults to the baked-in Cenotaph establishing shot. */
  scene: string;
  /** Character-portrait reference path, or null when --no-reference. */
  referencePath: string | null;
  referenceLabel: string;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let style: string | undefined;
  let label: string | undefined;
  let effort: ImageEffort = "standard";
  let aspect: ImageAspect = "landscape";
  let connectionId: string | undefined;
  let referencePath: string | null = DEFAULT_REFERENCE_PATH;
  let referenceLabel = DEFAULT_REFERENCE_LABEL;
  let scene = SCENE;
  for (const arg of argv) {
    if (arg.startsWith("--style=")) style = arg.slice("--style=".length);
    else if (arg.startsWith("--label=")) label = arg.slice("--label=".length);
    else if (arg.startsWith("--scene=")) scene = arg.slice("--scene=".length);
    else if (arg.startsWith("--scene-file=")) scene = readFileSync(arg.slice("--scene-file=".length), "utf8").trim();
    else if (arg.startsWith("--connection=")) connectionId = arg.slice("--connection=".length);
    else if (arg === "--no-reference") referencePath = null;
    else if (arg.startsWith("--reference=")) referencePath = arg.slice("--reference=".length);
    else if (arg.startsWith("--reference-label=")) referenceLabel = arg.slice("--reference-label=".length);
    else if (arg.startsWith("--effort=")) {
      const v = arg.slice("--effort=".length) as ImageEffort;
      if (!VALID_EFFORTS.includes(v)) die(`--effort must be one of ${VALID_EFFORTS.join("|")}`);
      effort = v;
    } else if (arg.startsWith("--aspect=")) {
      const v = arg.slice("--aspect=".length) as ImageAspect;
      if (!VALID_ASPECTS.includes(v)) die(`--aspect must be one of ${VALID_ASPECTS.join("|")}`);
      aspect = v;
    } else die(`Unknown arg: ${arg}`);
  }
  if (!style) die('Required: --style="<full style line ending in a caption directive>"');
  if (!label) label = "sample";
  if (referencePath && !existsSync(referencePath)) die(`Reference image not found: ${referencePath} (use --no-reference to skip)`);
  return { style, label, effort, aspect, connectionId, scene, referencePath, referenceLabel };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = `${args.scene}\n\n${args.style}`;

  const configDir = findConfigDir(REPO_ROOT);
  const store = loadConnectionStore(configDir);
  const conn = args.connectionId
    ? store.connections.find((c) => c.id === args.connectionId)
    : store.connections.find((c) => c.provider === "openai-chatgpt");
  if (!conn || conn.provider !== "openai-chatgpt") {
    die(`No usable openai-chatgpt connection in ${join(configDir, "connections.json")}.`);
  }

  const outDir = join(REPO_ROOT, ".style-samples");
  mkdirSync(outDir, { recursive: true });
  initEngineLog(outDir); // engine.jsonl breadcrumbs land under outDir/.debug

  // Load the baked-in character reference (same shape as loadCharacterReferences).
  const referenceImages = args.referencePath
    ? [{
        base64: readFileSync(args.referencePath).toString("base64"),
        mimeType: "image/png" as const,
        label: args.referenceLabel,
      }]
    : undefined;

  process.stderr.write(
    `▶ style-probe\n  connection: ${conn.id} (${conn.chatgptAccount?.email ?? "?"})\n` +
    `  label=${args.label} effort=${args.effort} aspect=${args.aspect}\n` +
    `  reference: ${referenceImages ? `${args.referenceLabel} <- ${args.referencePath}` : "(none)"}\n` +
    `  style: ${args.style}\n`,
  );

  const provider = createOpenAIChatGptProvider({
    sessionId: `style-probe-${process.pid}`,
    cwd: configDir,
    tokenStore: createConnectionTokenStore(configDir, conn.id),
  });

  try {
    const health = await provider.healthCheck();
    process.stderr.write(`  health: ${health.status} — ${health.message}\n`);
    if (health.status !== "valid") die(`Connection not usable (${health.status}).`);

    const start = Date.now();
    process.stderr.write(`  rendering…\n`);
    const res = await provider.generateImage({
      prompt,
      effort: args.effort,
      aspect: args.aspect,
      intent: "scene_snapshot",
      ...(referenceImages ? { referenceImages } : {}),
    });
    const dur = ((Date.now() - start) / 1000).toFixed(0);

    const path = join(outDir, `${args.label}.png`);
    writeFileSync(path, Buffer.from(res.base64, "base64"));
    process.stderr.write(
      `\n✔ rendered in ${dur}s — ${Buffer.byteLength(res.base64, "base64")} bytes\n` +
      `  aspect=${res.aspectUsed} effort=${res.effortUsed}\n` +
      `  saved: ${path}\n`,
    );
    if (res.revisedPrompt) process.stderr.write(`  revised: ${res.revisedPrompt.slice(0, 300)}\n`);
    process.stdout.write(`${path}\n`);
  } finally {
    await provider.dispose();
  }
}

main().catch((e) => {
  process.stderr.write(`\n✘ probe crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
