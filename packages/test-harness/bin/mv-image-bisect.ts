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
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/mv-image-bisect.ts \
 *     [--dump=<path to dm.json>] [--sys-frac=1.0] [--history=8|all] \
 *     [--samples=5] [--model=gpt-5.5] [--action="..."]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createOpenAIChatGptProvider } from "../../engine/src/providers/index.js";
import { createConnectionTokenStore } from "../../engine/src/providers/openai-chatgpt/index.js";
import type { NormalizedMessage, NormalizedTool, NormalizedToolCall } from "../../engine/src/providers/types.js";
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
  if (dropRange) {
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

  let fired = 0;
  const perSample: string[] = [];
  for (let i = 0; i < samples; i++) {
    // Fresh provider per sample → fresh thread/start, no cross-sample bleed.
    const provider = createOpenAIChatGptProvider({
      sessionId: `img-bisect-${process.pid}-${i}`,
      cwd: configDir,
      tokenStore: createConnectionTokenStore(configDir, conn.id),
    });
    const calls: NormalizedToolCall[] = [];
    let callCount = 0;
    const dispatchTool = async (call: NormalizedToolCall): Promise<{ content: string; isError?: boolean }> => {
      calls.push(call);
      callCount++;
      if (call.name === "generate_image") {
        return { content: JSON.stringify({ ok: true, status: "queued", note: "rendering in background" }) };
      }
      // Terse benign result for everything else; nudge to wrap up if it loops.
      if (callCount > 12) return { content: "ok — conclude the turn now." };
      return { content: "ok" };
    };
    const start = Date.now();
    try {
      const res = await provider.chat({
        model,
        systemPrompt,
        messages,
        maxTokens: 4000,
        baseInstructions: "",
        tools,
        dispatchTool,
      });
      const imgCalls = calls.filter((c) => c.name === "generate_image");
      const hit = imgCalls.length > 0;
      if (hit) fired++;
      const toolSummary = calls.map((c) => c.name).join(",") || "(none)";
      perSample.push(
        `  #${i + 1}: ${hit ? "🖼️ IMAGE" : "— no image"} (${Date.now() - start}ms) tools=[${toolSummary}]` +
          (hit ? `\n       prompt: ${String(imgCalls[0].input.prompt ?? "").slice(0, 160)}` : "") +
          `\n       text: ${(res.text || "(empty)").replace(/\s+/g, " ").trim().slice(0, 160)}`,
      );
      process.stderr.write(`  #${i + 1}: ${hit ? "IMAGE" : "no image"} (${Date.now() - start}ms, tools: ${toolSummary})\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      perSample.push(`  #${i + 1}: ERROR ${msg.slice(0, 200)}`);
      process.stderr.write(`  #${i + 1}: ERROR ${msg.slice(0, 200)}\n`);
    } finally {
      await provider.dispose();
    }
  }

  process.stdout.write(
    `\n=== RESULT ${shapeDesc} history=${historyN} cadence=${cadence ?? "8"} ===\n` +
      `fired ${fired}/${samples}\n` +
      perSample.join("\n") +
      "\n",
  );
  process.stderr.write(`\n▶ done — fired ${fired}/${samples}\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
