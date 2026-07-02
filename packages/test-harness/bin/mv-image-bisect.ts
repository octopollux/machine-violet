#!/usr/bin/env node
/**
 * DM image-suppressor bisection probe.
 *
 * Question: the DM (gpt-5.5 via codex) almost never fires `generate_image` in
 * live play, and its OOC self-report ("it's a taste/pacing call") is suspected
 * confabulation over an actual prompt bug. This probe binary-searches the DM
 * SYSTEM prompt: lop it to the first `--sys-frac` of its text, ALWAYS re-append
 * the image-gen directive section at the end, replay through the real provider,
 * and count how many of `--samples` turns actually call `generate_image`. If a
 * truncation suddenly unlocks imaging, the removed span held the suppressor.
 *
 * It replays a REAL captured DM request (`.debug/context/dm.json`) — real system
 * blocks, real tools, real recent history (flattened to text) — so the only
 * moving parts are the system truncation and the fixed test action.
 *
 * Method mirrors codex-base-instructions.ts: drive the live `openai-chatgpt`
 * connection, capture tool calls via dispatchTool. baseInstructions:"" matches
 * production (the coding-base strip). Live turns — ChatGPT-plan spend.
 *
 * Every run PRESERVES ITS ASSETS to `--out` (default ./.batch-runs/<ts>__<label>/):
 * per-sample narration.txt, tools + image prompts, the run's system-prompt.txt,
 * and run.json / run.md summaries — written incrementally so a mid-run quota
 * kill never loses completed samples. With `--render`, the DM's generate_image
 * calls are ACTUALLY rendered (real codex image turn) and the PNGs saved under
 * the sample dir and collected in the run's images/ folder for easy browsing.
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/mv-image-bisect.ts \
 *     [--dump=<path to dm.json>] [--sys-frac=1.0] [--history=8|all] \
 *     [--samples=5] [--model=gpt-5.5] [--action="..."] \
 *     [--render] [--out=<dir>] [--label=<name>]
 *   Shaping knobs (choose one): --sys-frac | --drop-blocks=2,6 | --drop-range=A-B
 *     | --add-range=A-B (onto --drop-blocks baseline) | --replace-range=A-B --replace-file=<f>
 *   Signal knobs: --cadence=N (raise freq target) | --force (imperative push)
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createOpenAIChatGptProvider } from "../../engine/src/providers/index.js";
import { createConnectionTokenStore } from "../../engine/src/providers/openai-chatgpt/index.js";
import type {
  NormalizedMessage,
  NormalizedTool,
  NormalizedToolCall,
  ImageEffort,
  ImageAspect,
} from "../../engine/src/providers/types.js";
import { loadConnectionStore } from "../../engine/src/config/connections.js";
import { initEngineLog } from "../../engine/src/context/engine-log.js";
import { REPO_ROOT, findConfigDir } from "../src/launch-env.js";

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const DEFAULT_DUMP = "C:/Users/quant/Documents/.machine-violet/campaigns/aurelia/.debug/context/dm.json";

/** A normal in-fiction beat with reveal potential — the DM claims reveals are
 *  prime image moments, so a dry result here is meaningful. */
const DEFAULT_ACTION =
  "[Colleen Rex] I unlatch the roof hatch, slide it aft, and lower my light into " +
  "the lift car for a clear look at the interior — especially the pale shape in the corner.";

interface Dump {
  system: { text: string }[];
  messages: { role: "user" | "assistant"; content: unknown }[];
  tools: NormalizedTool[];
}

/** Flatten a captured message's content to plain text (drop image_input / tool_use). */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Extract the image-gen directive section from the concatenated system text. */
function extractImageSection(fullSystem: string): string {
  const start = fullSystem.indexOf("When the `generate_image` tool is in your toolset");
  if (start < 0) throw new Error("Could not locate image-gen section start in system prompt.");
  const endMarker = "who they are in this world.";
  const endIdx = fullSystem.indexOf(endMarker, start);
  const end = endIdx >= 0 ? endIdx + endMarker.length : start + 2400;
  return fullSystem.slice(start, end).trim();
}

async function main(): Promise<void> {
  const model = arg("model", "gpt-5.5") ?? "gpt-5.5";
  const dumpPath = arg("dump", DEFAULT_DUMP) ?? DEFAULT_DUMP;
  const sysFrac = Number(arg("sys-frac", "1.0"));
  const historyRaw = arg("history", "8") ?? "8";
  const samples = Number(arg("samples", "5"));
  const action = arg("action", DEFAULT_ACTION) ?? DEFAULT_ACTION;
  const connectionId = arg("connection");
  // Signal amplifier: an explicit per-turn push so the UNLOCKED state fires
  // ~always and the SUPPRESSED state stays ~0 — crisp separation for bisection
  // (production cadence of 8/100 is too close to chance to resolve at small N).
  const force = process.argv.slice(2).includes("--force");
  const FORCE_LINE =
    "\n\nRIGHT NOW: this is a visually strong moment. Call `generate_image` this " +
    "turn with a vivid scene_snapshot BEFORE you finish narrating. Do not skip it.";
  // Cadence amplifier: raise the in-distribution frequency target (still a
  // judgment call, NOT a per-turn command like --force) so the unlocked state
  // fires well above the cadence-8 noise floor while the suppressor can still
  // pull it down. Rewrites the "roughly 8 images per 100" line in the section.
  const cadence = arg("cadence");
  // Surgical span removal: drop whole system blocks by index (comma-separated)
  // while keeping the rest ~intact. Size-matched drops (e.g. sys[2] directives
  // vs sys[6] data, both ~18KB) disentangle a SPECIFIC suppressor from generic
  // volume dilution. Overrides --sys-frac when present. The image section is
  // always re-appended, so dropping the block that holds it is safe.
  const dropBlocksRaw = arg("drop-blocks");
  const dropBlocks = new Set(
    (dropBlocksRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  );
  // Sub-block bisection: drop an absolute char span [START,END) from the joined
  // system text (then re-append the image section). Lets us split a single block
  // and localize the suppressor down to a sentence. Takes precedence over
  // --drop-blocks / --sys-frac.
  const dropRangeRaw = arg("drop-range");
  const dropRange = dropRangeRaw
    ? (dropRangeRaw.split("-").map(Number) as [number, number])
    : undefined;
  // Add-back: after building the base (typically via --drop-blocks=2, i.e. the
  // UNLOCKED baseline with all main directives removed), re-insert one original
  // system span [START,END). The right tool when suppression is REDUNDANT across
  // spans — dropping one span never unlocks (another still suppresses), so instead
  // add spans back onto an unlocked base and watch for the one that RE-SUPPRESSES.
  const addRangeRaw = arg("add-range");
  const addRange = addRangeRaw
    ? (addRangeRaw.split("-").map(Number) as [number, number])
    : undefined;
  // Fix test: replace an original system span [START,END) with the text in
  // --replace-file, keeping the rest of the FULL prompt intact. Validates the
  // exact reword before it's applied to dm-directives.md — in-situ, realistic.
  const replaceRangeRaw = arg("replace-range");
  const replaceRange = replaceRangeRaw
    ? (replaceRangeRaw.split("-").map(Number) as [number, number])
    : undefined;
  const replaceFile = arg("replace-file");
  // Asset preservation (this harness is load-bearing for playtesting at scale —
  // every run writes its narration, tool calls, image prompts, and (with
  // --render) the actual PNGs to disk, incrementally, so nothing is ever lost to
  // a mid-run quota kill again).
  const render = process.argv.slice(2).includes("--render");
  const outRoot = arg("out") ?? join(process.cwd(), ".batch-runs");
  const label = arg("label");

  const dump: Dump = JSON.parse(readFileSync(dumpPath, "utf8"));

  // --- Build the (possibly truncated) system prompt --------------------------
  const fullSystem = dump.system.map((b) => b.text).join("\n\n");
  let imageSection = extractImageSection(fullSystem);
  if (cadence) {
    imageSection = imageSection.replace(
      /roughly \d+ images across every 100/,
      `roughly ${cadence} images across every 100`,
    );
  }
  let base: string;
  let shapeDesc: string;
  if (replaceRange && replaceFile) {
    const [rs, re] = replaceRange;
    const repl = readFileSync(replaceFile, "utf8");
    base = fullSystem.slice(0, rs) + repl + fullSystem.slice(re);
    shapeDesc = `replace-range=${rs}-${re} with ${repl.length}-char file (full ${fullSystem.length}→${base.length})`;
  } else if (dropRange) {
    const [s, e] = dropRange;
    base = fullSystem.slice(0, s) + fullSystem.slice(e);
    shapeDesc = `drop-range=${s}-${e} (removed ${e - s} chars: "${fullSystem.slice(s, s + 50).replace(/\s+/g, " ").trim()}…")`;
  } else if (dropBlocks.size > 0) {
    const kept = dump.system.filter((_, i) => !dropBlocks.has(i));
    base = kept.map((b) => b.text).join("\n\n");
    shapeDesc = `drop-blocks=[${[...dropBlocks].join(",")}] (system ${fullSystem.length}→${base.length} chars)`;
  } else {
    const keepChars = Math.max(0, Math.round(fullSystem.length * sysFrac));
    base = fullSystem.slice(0, keepChars);
    shapeDesc = `sys-frac=${sysFrac} (system ${fullSystem.length}→${keepChars} chars)`;
  }
  if (addRange) {
    const [as, ae] = addRange;
    const span = fullSystem.slice(as, ae);
    base = `${base}\n\n${span}`;
    shapeDesc += ` +add-range=${as}-${ae} (re-added ${ae - as} chars: "${span.slice(0, 50).replace(/\s+/g, " ").trim()}…")`;
  }
  const systemPrompt = `${base}\n\n${imageSection}${force ? FORCE_LINE : ""}`;

  // --- Build history (flattened to text) + fixed test action -----------------
  const flat: NormalizedMessage[] = dump.messages.map((m) => ({
    role: m.role,
    content: flattenContent(m.content),
  }));
  // Drop the trailing OOC user turn we recorded, keep the rest as scene history.
  const scene = flat.slice(0, flat.length - 1).filter((m) => m.content.trim().length > 0);
  const historyN = historyRaw === "all" ? scene.length : Number(historyRaw);
  const history = scene.slice(Math.max(0, scene.length - historyN));
  const messages: NormalizedMessage[] = [...history, { role: "user", content: action }];

  const tools = dump.tools;

  process.stderr.write(
    `▶ image-bisect — model=${model} ${shapeDesc} force=${force} cadence=${cadence ?? "8(default)"} ` +
      `+ ${imageSection.length}-char image section, ` +
      `history=${historyN}/${scene.length} msgs, samples=${samples}\n`,
  );

  // --- Connection ------------------------------------------------------------
  const configDir = findConfigDir(REPO_ROOT);
  initEngineLog(join(configDir, "campaigns"));
  const store = loadConnectionStore(configDir);
  const conn = connectionId
    ? store.connections.find((c) => c.id === connectionId)
    : store.connections.find((c) => c.provider === "openai-chatgpt");
  if (!conn || conn.provider !== "openai-chatgpt") {
    process.stderr.write(`No openai-chatgpt connection in ${join(configDir, "connections.json")}.\n`);
    process.exit(1);
  }

  // --- Run output directory (assets preserved here, written incrementally) ---
  const runId = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const slug = (label ?? shapeDesc.split(" ")[0] ?? "run").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  const runDir = join(outRoot, `${runId}__${slug}`);
  const samplesDir = join(runDir, "samples");
  const imagesDir = join(runDir, "images");
  mkdirSync(samplesDir, { recursive: true });
  if (render) mkdirSync(imagesDir, { recursive: true });
  writeFileSync(join(runDir, "system-prompt.txt"), systemPrompt);
  writeFileSync(join(runDir, "action.txt"), action);
  process.stderr.write(`  out: ${runDir}\n`);

  interface ImgAsset { prompt: string; effort?: string; aspect?: string; intent?: string; file?: string; revisedPrompt?: string; error?: string; }
  interface SampleRec { i: number; status: "image" | "no-image" | "error"; ms: number; tools: string[]; images: ImgAsset[]; narration?: string; error?: string; }
  const records: SampleRec[] = [];
  let fired = 0;
  const perSample: string[] = [];

  for (let i = 0; i < samples; i++) {
    const n2 = String(i + 1).padStart(2, "0");
    const sampleDir = join(samplesDir, n2);
    mkdirSync(sampleDir, { recursive: true });
    // Fresh provider per sample → fresh thread/start, no cross-sample bleed.
    const provider = createOpenAIChatGptProvider({
      sessionId: `img-bisect-${process.pid}-${i}`,
      cwd: configDir,
      tokenStore: createConnectionTokenStore(configDir, conn.id),
    });
    const calls: NormalizedToolCall[] = [];
    const imgAssets: ImgAsset[] = [];
    let callCount = 0;
    let imgSeq = 0;
    const dispatchTool = async (call: NormalizedToolCall): Promise<{ content: string; isError?: boolean }> => {
      calls.push(call);
      callCount++;
      if (call.name === "generate_image") {
        const inp = call.input as Record<string, unknown>;
        imgSeq++;
        const asset: ImgAsset = {
          prompt: String(inp.prompt ?? ""),
          effort: inp.effort as string | undefined,
          aspect: inp.aspect as string | undefined,
          intent: inp.intent as string | undefined,
        };
        writeFileSync(join(sampleDir, `image-${imgSeq}.prompt.txt`), asset.prompt);
        if (render && provider.generateImage) {
          try {
            const r = await provider.generateImage({
              prompt: asset.prompt,
              effort: (asset.effort as ImageEffort | undefined),
              aspect: (asset.aspect as ImageAspect | undefined),
              intent: asset.intent as "scene_snapshot" | "player_request" | "character_portrait" | undefined,
            });
            const ext = r.mimeType === "image/jpeg" ? "jpg" : r.mimeType === "image/webp" ? "webp" : "png";
            const fname = `s${n2}-img${imgSeq}.${ext}`;
            writeFileSync(join(sampleDir, `image-${imgSeq}.${ext}`), Buffer.from(r.base64, "base64"));
            writeFileSync(join(imagesDir, fname), Buffer.from(r.base64, "base64"));
            asset.file = fname;
            asset.revisedPrompt = r.revisedPrompt;
          } catch (e) {
            asset.error = e instanceof Error ? e.message : String(e);
          }
        }
        imgAssets.push(asset);
        return { content: JSON.stringify({ ok: true, status: render ? "rendered" : "queued" }) };
      }
      // Terse benign result for everything else; nudge to wrap up if it loops.
      if (callCount > 12) return { content: "ok — conclude the turn now." };
      return { content: "ok" };
    };
    const start = Date.now();
    let rec: SampleRec;
    try {
      const res = await provider.chat({
        model, systemPrompt, messages, maxTokens: 4000, baseInstructions: "", tools, dispatchTool,
      });
      const ms = Date.now() - start;
      const hit = imgAssets.length > 0;
      if (hit) fired++;
      const toolNames = calls.map((c) => c.name);
      rec = { i: i + 1, status: hit ? "image" : "no-image", ms, tools: toolNames, images: imgAssets, narration: res.text || "" };
      writeFileSync(join(sampleDir, "narration.txt"), res.text || "(empty)");
      perSample.push(
        `  #${i + 1}: ${hit ? "🖼️ IMAGE" : "— no image"} (${ms}ms) tools=[${toolNames.join(",") || "(none)"}]` +
          (hit ? `\n       prompt: ${imgAssets[0].prompt.slice(0, 160)}` : "") +
          `\n       text: ${(res.text || "(empty)").replace(/\s+/g, " ").trim().slice(0, 160)}`,
      );
      process.stderr.write(`  #${i + 1}: ${hit ? "IMAGE" + (render ? "(rendered)" : "") : "no image"} (${ms}ms, tools: ${toolNames.join(",") || "none"})\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rec = { i: i + 1, status: "error", ms: Date.now() - start, tools: calls.map((c) => c.name), images: imgAssets, error: msg };
      perSample.push(`  #${i + 1}: ERROR ${msg.slice(0, 200)}`);
      process.stderr.write(`  #${i + 1}: ERROR ${msg.slice(0, 200)}\n`);
    } finally {
      await provider.dispose();
    }
    records.push(rec);
    // Write per-sample + rolling run summary EACH iteration so a mid-run kill
    // (e.g. quota) never loses completed samples.
    writeFileSync(join(sampleDir, "sample.json"), JSON.stringify(rec, null, 2));
    writeRunSummary(runDir, { shapeDesc, historyN, cadence: cadence ?? "8", samples, model, render, action, fired, records });
  }

  process.stdout.write(
    `\n=== RESULT ${shapeDesc} history=${historyN} cadence=${cadence ?? "8"} ===\n` +
      `fired ${fired}/${samples}` +
      `${records.some((r) => r.status === "error") ? ` (${records.filter((r) => r.status === "error").length} errored — excluded)` : ""}\n` +
      perSample.join("\n") +
      `\nout: ${runDir}\n`,
  );
  process.stderr.write(`\n▶ done — fired ${fired}/${samples} — assets in ${runDir}\n`);
}

/** Machine-readable + human-readable run summary. Rewritten every sample so a
 *  mid-run kill still leaves an accurate partial record. */
function writeRunSummary(
  runDir: string,
  s: {
    shapeDesc: string; historyN: number; cadence: string | number; samples: number; model: string;
    render: boolean; action: string;
    fired: number;
    records: { i: number; status: string; ms: number; tools: string[]; images: { prompt: string; file?: string; error?: string }[]; narration?: string; error?: string }[];
  },
): void {
  const valid = s.records.filter((r) => r.status !== "error");
  const errored = s.records.filter((r) => r.status === "error").length;
  const rate = valid.length > 0 ? (s.fired / valid.length) : 0;
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    shapeDesc: s.shapeDesc, historyN: s.historyN, cadence: s.cadence, samplesRequested: s.samples,
    model: s.model, render: s.render, action: s.action,
    fired: s.fired, completed: s.records.length, valid: valid.length, errored,
    fireRateOverValid: Number(rate.toFixed(3)),
    records: s.records,
  }, null, 2));
  const lines: string[] = [
    `# Batch run: ${s.shapeDesc}`,
    "",
    `- model: ${s.model} | cadence: ${s.cadence} | history: ${s.historyN} | render: ${s.render}`,
    `- **fired ${s.fired}/${valid.length} valid** (${(rate * 100).toFixed(0)}%)${errored ? ` — ${errored} errored, excluded` : ""}`,
    `- action: ${s.action}`,
    "",
    "| # | result | ms | tools | image prompt |",
    "|---|---|---|---|---|",
    ...s.records.map((r) => {
      const p = r.images[0]?.prompt.replace(/\s+/g, " ").slice(0, 80).replace(/\|/g, "\\|") ?? "";
      const st = r.status === "image" ? "🖼️" : r.status === "error" ? "⚠️ err" : "—";
      return `| ${r.i} | ${st} | ${r.ms} | ${r.tools.join(" ") || "-"} | ${p} |`;
    }),
  ];
  writeFileSync(join(runDir, "run.md"), lines.join("\n") + "\n");

  // Aggregated transcripts — every sample's FULL narration in one scrollable
  // file, for reviewing transcripts at volume across a dimension. Kept in sync
  // each sample so it's always complete-so-far.
  const t: string[] = [
    `# Transcripts — ${s.shapeDesc}`,
    `_${s.model} · cadence ${s.cadence} · history ${s.historyN} · render ${s.render} · fired ${s.fired}/${valid.length} valid_`,
    "",
    `**Action (identical every sample):** ${s.action}`,
    "",
  ];
  for (const r of s.records) {
    const st = r.status === "image" ? "🖼️ IMAGE" : r.status === "error" ? "⚠️ ERROR" : "— no image";
    t.push(`\n---\n\n## Sample ${r.i} — ${st}  ·  ${r.ms}ms  ·  tools: ${r.tools.join(", ") || "none"}`);
    for (const img of r.images) {
      t.push(`\n> 🖼️ **image prompt** (${img.intent ?? "?"}/${img.effort ?? "?"}/${img.aspect ?? "?"}${img.file ? `, saved ${img.file}` : img.error ? `, render error: ${img.error}` : ""}):\n> ${img.prompt.replace(/\n/g, "\n> ")}`);
    }
    if (r.error) t.push(`\n\`\`\`\n${r.error}\n\`\`\``);
    if (r.narration) t.push(`\n${r.narration}`);
  }
  writeFileSync(join(runDir, "transcripts.md"), t.join("\n") + "\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
