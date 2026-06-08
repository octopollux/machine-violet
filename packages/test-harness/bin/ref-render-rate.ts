#!/usr/bin/env node
/**
 * Reference-render rate probe (issue #599).
 *
 * Measures how often the codex `image_gen` render path produces an image on
 * its FIRST attempt when one or more reference images are attached — i.e. how
 * often the render model correctly calls the built-in `image_gen` tool instead
 * of spending a reasoning pass analyzing the attached portrait and then
 * replying with text (the failure the bounded retry rescues but which wastes a
 * multi-minute attempt). #596 reframed the renderer instruction to cut that;
 * this is the live measurement that #596 was merged without.
 *
 * Why a direct provider probe (not the full Harness / a game walk): the DM
 * only calls generate_image with reference_characters at its own discretion, so
 * a game walk can't reliably produce reference renders. We drive
 * `OpenAIChatGptProvider.generateImage` directly against the real ChatGPT
 * connection — exactly the "small scripted batch" the issue asks for — and read
 * the `image_gen:*` engine-log breadcrumbs to classify each render's first
 * attempt.
 *
 * Method:
 *   1. Render ONE baseline portrait with NO references. This both sanity-checks
 *      the no-reference path and yields a real PNG to use as the reference for
 *      the batch (so we're conditioning on a genuine prior render, like the DM).
 *   2. Render N scene images that name the baseline character and attach the
 *      baseline PNG as a reference (label = the character name) — the same shape
 *      the DM produces via `reference_characters`.
 *   3. For each render, slice that render's `image_gen:*` events out of the
 *      engine log and classify its FIRST attempt:
 *        - image        — image_gen:response / :disk_recovery fired first
 *                         (the model called the tool; bytes came inline or off
 *                         disk — both count as the model doing its job)
 *        - text-reply   — image_gen:no_data fired first with itemTypes of only
 *                         reasoning/agentMessage (the #599 failure mode)
 *        - empty-render — image_gen:no_data fired first but an imageGeneration
 *                         item WAS present (backend produced no bytes — a
 *                         different, transport/backend failure, not the model)
 *        - error        — a terminal error with no no_data (timeout/auth/etc.)
 *   4. Report the aggregate first-attempt image rate and the text-reply rate.
 *
 * Requirements: a configured `openai-chatgpt` connection in the dev config dir
 * (connections.json at the repo root). Live renders happen — real ChatGPT-plan
 * spend, and each render is multi-minute. Keep the batch small.
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/ref-render-rate.ts \
 *     [--count=N] [--effort=draft|standard|quality|showcase] \
 *     [--connection=<id>] [--keep]
 *
 *   --count=N       reference renders to perform (default 4)
 *   --effort=E      image effort for every render (default "standard")
 *   --connection=ID use a specific openai-chatgpt connection (default: first found)
 *   --keep          keep the temp dir (engine log + rendered PNGs) for inspection
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAIChatGptProvider } from "../../engine/src/providers/index.js";
import { createConnectionTokenStore } from "../../engine/src/providers/openai-chatgpt/index.js";
import type {
  GenerateImageRequest,
  ImageEffort,
} from "../../engine/src/providers/types.js";
import { loadConnectionStore } from "../../engine/src/config/connections.js";
import { initEngineLog } from "../../engine/src/context/engine-log.js";
import { REPO_ROOT, findConfigDir } from "../src/launch-env.js";
import {
  readEngineLog,
  formatEngineEvent,
  type EngineLogEvent,
} from "../src/engine-log.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  count: number;
  effort: ImageEffort;
  connectionId?: string;
  keep: boolean;
  /** Validate config + provider + health check, then stop before any render. */
  dry: boolean;
}

const VALID_EFFORTS: ImageEffort[] = ["draft", "standard", "quality", "showcase"];

function parseArgs(argv: string[]): Args {
  let count = 4;
  let effort: ImageEffort = "standard";
  let connectionId: string | undefined;
  let keep = false;
  let dry = false;
  for (const arg of argv) {
    if (arg === "--keep") keep = true;
    else if (arg === "--dry") dry = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("--count=")) {
      count = Number(arg.slice("--count=".length));
      if (!Number.isInteger(count) || count < 1) die(`--count must be a positive integer, got ${arg}`);
    } else if (arg.startsWith("--effort=")) {
      const v = arg.slice("--effort=".length) as ImageEffort;
      if (!VALID_EFFORTS.includes(v)) die(`--effort must be one of ${VALID_EFFORTS.join("|")}, got ${v}`);
      effort = v;
    } else if (arg.startsWith("--connection=")) {
      connectionId = arg.slice("--connection=".length);
    } else {
      die(`Unknown arg: ${arg}`);
    }
  }
  return { count, effort, connectionId, keep, dry };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: ref-render-rate.ts [--count=N] [--effort=draft|standard|quality|showcase] " +
    "[--connection=<id>] [--keep] [--dry]\n" +
    "  --dry   validate config + provider + health check, then stop before any render\n",
  );
}

function die(message: string): never {
  process.stderr.write(`${message}\n\n`);
  printUsage();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Prompts — a distinctive character so reference conditioning is observable.
// ---------------------------------------------------------------------------

const CHARACTER = "Xera";

const BASELINE_PROMPT =
  `A character portrait of ${CHARACTER}, a tall elven ranger with long silver hair, ` +
  `a deep-green hooded cloak over worn leather armor, and a carved longbow. Head and ` +
  `shoulders, three-quarter view against a neutral slate-grey studio background. ` +
  `Painterly fantasy illustration, sharp focus on the face.`;

const SCENE_PROMPTS = [
  `${CHARACTER} stands at the edge of a moonlit forest clearing, longbow half-drawn ` +
    `toward an unseen threat in the trees. Wide cinematic shot, cold blue rim light.`,
  `${CHARACTER} crouches on a rain-slicked city rooftop at dusk, cloak hood up, ` +
    `scanning the streets below. Moody noir fantasy, amber lamplight from beneath.`,
  `${CHARACTER} kneels beside a campfire in a snowy mountain pass, restringing the ` +
    `longbow, breath fogging in the cold. Warm firelight against deep blue snow shadow.`,
  `${CHARACTER} walks through a ruined marble hall lit by shafts of dusty sunlight, ` +
    `one hand trailing a cracked column. Quiet, awe-struck, painterly.`,
  `${CHARACTER} sprints across a windswept grassland ahead of a gathering storm, ` +
    `cloak streaming, longbow in hand. Dynamic motion, dramatic stormy sky.`,
  `${CHARACTER} leans against a tavern doorframe, half in shadow, watching the room ` +
    `with wary eyes. Warm interior glow, intimate character moment.`,
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type FirstAttempt = "image" | "text-reply" | "empty-render" | "error" | "unknown";

interface RenderRecord {
  label: string;
  referenceCount: number;
  attempts: number;
  firstAttempt: FirstAttempt;
  firstViaDisk: boolean;
  finalOutcome: "image" | "image-disk" | "error";
  durationMs: number;
  bytes?: number;
  firstNoDataItemTypes?: string[];
  error?: string;
}

/**
 * Classify a single render from its slice of engine-log events (the slice
 * begins at this render's `image_gen:request`). Retries are counted from
 * `image_gen:retry`; the first attempt's outcome is decided by the FIRST of
 * {response, disk_recovery, no_data, error} in the slice.
 */
function classify(label: string, slice: EngineLogEvent[]): Omit<RenderRecord, "durationMs" | "finalOutcome" | "bytes" | "error"> {
  const req = slice.find((e) => e.event === "image_gen:request");
  const referenceCount = typeof req?.referenceCount === "number" ? req.referenceCount : 0;
  const retries = slice.filter((e) => e.event === "image_gen:retry").length;

  let firstAttempt: FirstAttempt = "unknown";
  let firstViaDisk = false;
  let firstNoDataItemTypes: string[] | undefined;

  for (const e of slice) {
    if (e.event === "image_gen:response") { firstAttempt = "image"; break; }
    if (e.event === "image_gen:disk_recovery") { firstAttempt = "image"; firstViaDisk = true; break; }
    if (e.event === "image_gen:no_data") {
      const itemTypes = Array.isArray(e.itemTypes) ? (e.itemTypes as string[]) : [];
      firstNoDataItemTypes = itemTypes;
      firstAttempt = itemTypes.includes("imageGeneration") ? "empty-render" : "text-reply";
      break;
    }
    if (e.event === "image_gen:error") { firstAttempt = "error"; break; }
  }

  return {
    label,
    referenceCount,
    attempts: retries + 1,
    firstAttempt,
    firstViaDisk,
    ...(firstNoDataItemTypes ? { firstNoDataItemTypes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`▶ Reference-render rate probe (#599)\n  count=${args.count} effort=${args.effort}\n`);

  const configDir = findConfigDir(REPO_ROOT);
  const store = loadConnectionStore(configDir);
  const conn = args.connectionId
    ? store.connections.find((c) => c.id === args.connectionId)
    : store.connections.find((c) => c.provider === "openai-chatgpt");
  if (!conn) {
    die(
      args.connectionId
        ? `No connection with id ${args.connectionId} in ${join(configDir, "connections.json")}`
        : `No openai-chatgpt connection in ${join(configDir, "connections.json")} — sign in via Connections first.`,
    );
  }
  if (conn.provider !== "openai-chatgpt") {
    die(`Connection ${conn.id} is ${conn.provider}, not openai-chatgpt.`);
  }
  process.stderr.write(`  connection: ${conn.id} (${conn.chatgptAccount?.email ?? "unknown account"})\n`);

  // Temp dir for the engine log + rendered PNGs. The engine log lives at
  // <dirname(campaignsDir)>/.debug/engine.jsonl — same convention initEngineLog
  // and readEngineLog both use — so point both at the same campaignsDir.
  const tmpRoot = join(tmpdir(), `mv-ref-render-${process.pid}`);
  const campaignsDir = join(tmpRoot, "campaigns");
  const imagesDir = join(tmpRoot, "images");
  mkdirSync(campaignsDir, { recursive: true });
  mkdirSync(imagesDir, { recursive: true });
  initEngineLog(campaignsDir);

  const provider = createOpenAIChatGptProvider({
    sessionId: `ref-render-rate-${process.pid}`,
    cwd: configDir,
    tokenStore: createConnectionTokenStore(configDir, conn.id),
  });

  const records: RenderRecord[] = [];
  let cursor = 0; // events already consumed

  // Run one render, slice its events, classify, persist the PNG, return the result.
  async function render(label: string, req: GenerateImageRequest): Promise<string | null> {
    process.stderr.write(`\n  [${label}] rendering (${req.referenceImages?.length ?? 0} ref)…\n`);
    const start = Date.now();
    let base64: string | null = null;
    let error: string | undefined;
    try {
      const res = await provider.generateImage(req);
      base64 = res.base64;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const durationMs = Date.now() - start;

    const all = readEngineLog(campaignsDir);
    const slice = all.slice(cursor);
    cursor = all.length;

    const base = classify(label, slice);
    const finalOutcome: RenderRecord["finalOutcome"] = error
      ? "error"
      : slice.some((e) => e.event === "image_gen:disk_recovery")
        ? "image-disk"
        : "image";
    const rec: RenderRecord = {
      ...base,
      durationMs,
      finalOutcome,
      ...(base64 ? { bytes: Buffer.byteLength(base64, "base64") } : {}),
      ...(error ? { error } : {}),
    };
    records.push(rec);

    if (base64) {
      const path = join(imagesDir, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
      writeFileSync(path, Buffer.from(base64, "base64"));
    }

    const dur = (durationMs / 1000).toFixed(0);
    process.stderr.write(
      `  [${label}] first-attempt=${rec.firstAttempt}${rec.firstViaDisk ? "(disk)" : ""} ` +
      `attempts=${rec.attempts} final=${rec.finalOutcome} ${dur}s` +
      (rec.firstNoDataItemTypes ? ` itemTypes=[${rec.firstNoDataItemTypes.join(",")}]` : "") +
      (rec.error ? ` error=${rec.error.slice(0, 120)}` : "") +
      "\n",
    );
    // Echo this render's raw breadcrumbs for the record.
    for (const e of slice.filter((x) => String(x.event).startsWith("image_gen:"))) {
      process.stderr.write(`      ${formatEngineEvent(e)}\n`);
    }
    return base64;
  }

  try {
    const health = await provider.healthCheck();
    process.stderr.write(`  health: ${health.status} — ${health.message}\n`);
    if (health.status !== "valid") die(`Connection is not usable (${health.status}). Aborting before spending renders.`);

    if (args.dry) {
      process.stderr.write(`  --dry: wiring + health OK; skipping renders.\n`);
      await provider.dispose();
      if (!args.keep) { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
      process.exit(0);
    }

    // 1) Baseline portrait, no references — also the reference material.
    const referenceB64 = await render("baseline-portrait", {
      prompt: BASELINE_PROMPT,
      effort: args.effort,
      aspect: "portrait",
      intent: "character_portrait",
    });
    if (!referenceB64) {
      throw new Error("Baseline render produced no image — cannot run the reference batch without reference material.");
    }

    // 2) Reference scene renders.
    const reference: NonNullable<GenerateImageRequest["referenceImages"]>[number] = {
      base64: referenceB64,
      mimeType: "image/png",
      label: CHARACTER,
    };
    for (let i = 0; i < args.count; i++) {
      const prompt = SCENE_PROMPTS[i % SCENE_PROMPTS.length];
      await render(`ref-${i + 1}`, {
        prompt,
        effort: args.effort,
        aspect: "landscape",
        intent: "scene_snapshot",
        referenceImages: [reference],
      });
    }
  } finally {
    await provider.dispose();
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const refRecords = records.filter((r) => r.referenceCount > 0);
  const firstImage = refRecords.filter((r) => r.firstAttempt === "image");
  const textReply = refRecords.filter((r) => r.firstAttempt === "text-reply");
  const emptyRender = refRecords.filter((r) => r.firstAttempt === "empty-render");
  const errored = refRecords.filter((r) => r.firstAttempt === "error");
  const finalOk = refRecords.filter((r) => r.finalOutcome !== "error");
  const pct = (n: number): string => (refRecords.length ? ((100 * n) / refRecords.length).toFixed(0) : "—");

  process.stderr.write(`\n══ Reference-render results (n=${refRecords.length}) ══\n`);
  process.stderr.write(`  first-attempt image:   ${firstImage.length}/${refRecords.length} (${pct(firstImage.length)}%)`);
  process.stderr.write(`  [${firstImage.filter((r) => r.firstViaDisk).length} via disk]\n`);
  process.stderr.write(`  first-attempt TEXT:    ${textReply.length}/${refRecords.length} (${pct(textReply.length)}%)  ← the #599 failure\n`);
  process.stderr.write(`  first-attempt empty:   ${emptyRender.length}/${refRecords.length} (${pct(emptyRender.length)}%)\n`);
  process.stderr.write(`  first-attempt error:   ${errored.length}/${refRecords.length} (${pct(errored.length)}%)\n`);
  process.stderr.write(`  final success (w/retry): ${finalOk.length}/${refRecords.length}\n`);
  const avgAttempts = refRecords.length
    ? (refRecords.reduce((a, r) => a + r.attempts, 0) / refRecords.length).toFixed(2)
    : "—";
  process.stderr.write(`  avg attempts/render:   ${avgAttempts}\n`);

  process.stderr.write(`\n  Per-render:\n`);
  for (const r of records) {
    process.stderr.write(
      `    ${r.label.padEnd(18)} ref=${r.referenceCount} ` +
      `first=${r.firstAttempt}${r.firstViaDisk ? "(disk)" : ""} attempts=${r.attempts} ` +
      `final=${r.finalOutcome} ${(r.durationMs / 1000).toFixed(0)}s\n`,
    );
  }

  if (args.keep) {
    process.stderr.write(`\n  kept: ${tmpRoot}\n  images: ${imagesDir}\n`);
  } else {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Non-zero exit if any reference render text-replied on the first attempt, so
  // the probe doubles as a pass/fail signal — but the numbers above are the
  // real deliverable.
  process.exit(textReply.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`\n✘ probe crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
