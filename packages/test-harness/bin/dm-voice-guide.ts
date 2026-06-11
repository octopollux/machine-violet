#!/usr/bin/env node
/**
 * DM voice-guide generator (personality-prior authoring tool).
 *
 * Asks the DM — primed with the real Core DM Identity, a chosen DM personality
 * block, and the live formatting rules — to write a short guide, IN ITS OWN
 * VOICE and in the SECOND PERSON, describing how it speaks and what it says,
 * with examples. The output is shaped to drop straight into a personality
 * block's `detail` field as a deeper, example-rich voice prior: showing the
 * model its own voice beats describing it.
 *
 * We deliberately drive GPT-5.5 rather than Claude. Its personality vector is
 * softer, so it adopts an authored voice more readily and with less of the
 * assistant register bleeding through — the whole point of seeding a stronger
 * prior with minimal harness/assistant interference.
 *
 * Standalone on purpose: this talks to the OpenAI SDK's Responses API directly
 * rather than going through the engine's provider stack, so there's nothing to
 * fight when iterating on the prompt. Reasoning is requested at HIGH effort and
 * each run reports the reasoning-token count (proof it fired) plus any summary.
 *
 * Two modes:
 *   - single: one personality, printed to stdout (diagnostics to stderr).
 *   - batch ("all"): every `personalities/*.mvdm` seed, fanned out concurrently
 *     (native Promise pool, not subagents — these are pure API calls), collected
 *     into a CSV for review.
 *
 * Run (PowerShell — the key lives in the User-scope env on this box):
 *
 *   $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')
 *   node --import tsx/esm packages/test-harness/bin/dm-voice-guide.ts [slug|all]
 *
 * `slug` defaults to `the-crossroads`. `all` runs the full corpus and writes
 * `voice-guides/dm-voice-guides.csv`. Concurrency: env VOICE_GUIDE_CONCURRENCY
 * (default 6).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import OpenAI from "openai";

const MODEL = "gpt-5.5";
const REASONING_EFFORT = "high" as const;
// Ceiling, not a target. High-effort reasoning tokens count against the output
// budget, so leave generous headroom above the ~few-hundred-token guide so the
// visible text is never starved by the thinking pass.
const MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_CONCURRENCY = 6;

// repo root = three levels up from packages/test-harness/bin
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf-8").replace(/\r\n/g, "\n");
}

/** Pull a single top-level <tag>...</tag> block out of a prompt file. */
function extractBlock(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  const inner = m?.[1];
  if (inner === undefined) throw new Error(`could not find <${tag}> block`);
  return inner.trim();
}

/**
 * Resolve the formatting block the way `loadPrompt` would for a GPT model:
 * keep the `<!--if:gpt-->` content (we ARE calling a GPT model), and strip the
 * conditional markers, include directives, block/line comments, and blank runs.
 */
function resolveForGpt(block: string): string {
  return block
    .replace(/<!--if:gpt-->\n?/g, "")
    .replace(/<!--endif-->\n?/g, "")
    .replace(/<!--include:[^>]*-->\n?/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^%%[^\n]*\n?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Personality {
  name: string;
  prompt_fragment?: string;
  detail?: string;
}

function loadPersonality(slug: string): Personality {
  const parsed: unknown = JSON.parse(read(join("personalities", `${slug}.mvdm`)));
  const p = parsed as Personality;
  if (!p.name) throw new Error(`personality ${slug} has no "name"`);
  return p;
}

/** The personality block = prompt_fragment + detail, as the DM prompt layers them. */
function personalityBlock(p: Personality): string {
  return [p.prompt_fragment?.trim(), p.detail?.trim()].filter(Boolean).join("\n\n");
}

/**
 * Assemble the system/user split that mirrors how the real DM is primed:
 * identity + personality + formatting are the cached system prefix; the writing
 * request is the turn, with the persona repeated as a closing "Reminder:" to
 * reinforce the voice right before generation.
 */
function buildPrompt(
  identity: string,
  formatting: string,
  persona: string,
): { instructions: string; task: string } {
  const instructions = [identity, persona, formatting].join("\n\n");
  const task = [
    "You are writing a guide to pass along your personality to another agent who will inherit your voice. " +
      "Write 2-3 paragraphs in the second person — address that agent directly as \"you\" (\"You speak like…\", \"You never…\") — " +
      "describing how you speak and what you say, with examples. " +
      "It is more important that it be idiomatic and full of personality than it be technically sound.",
    "",
    "Reminder:",
    persona,
  ].join("\n");
  return { instructions, task };
}

interface GuideResult {
  slug: string;
  name: string;
  status: string;
  reasoningTokens: number;
  inputTokens: number;
  outputTokens: number;
  guide: string;
  summary: string;
  error?: string;
}

/**
 * One personality → one guide. Catches its own errors and returns them in the
 * result so a batch run never aborts on a single bad seed.
 */
async function generateGuide(
  client: OpenAI,
  identity: string,
  formatting: string,
  slug: string,
): Promise<GuideResult> {
  const base: GuideResult = {
    slug,
    name: slug,
    status: "error",
    reasoningTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    guide: "",
    summary: "",
  };
  try {
    const personality = loadPersonality(slug);
    const persona = personalityBlock(personality);
    const { instructions, task } = buildPrompt(identity, formatting, persona);

    // Primary attempt asks for a reasoning summary. Some orgs gate summaries
    // behind verification; if that's the only complaint, retry without it — the
    // reasoning_tokens count still proves reasoning ran.
    const callModel = (withSummary: boolean) =>
      client.responses.create({
        model: MODEL,
        instructions,
        input: task,
        reasoning: withSummary
          ? { effort: REASONING_EFFORT, summary: "auto" }
          : { effort: REASONING_EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      });

    let response;
    try {
      response = await callModel(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/summary|verif/i.test(msg)) {
        response = await callModel(false);
      } else {
        throw e;
      }
    }

    const summaries: string[] = [];
    for (const item of response.output) {
      if (item.type === "reasoning") {
        for (const s of item.summary ?? []) {
          if (s.type === "summary_text" && s.text) summaries.push(s.text);
        }
      }
    }

    return {
      slug,
      name: personality.name,
      status: response.status ?? "unknown",
      reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      guide: response.output_text.trim(),
      summary: summaries.join("\n\n"),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Bounded-concurrency map. Native promise pool — order of results preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    let i = next++;
    while (i < items.length) {
      results[i] = await fn(items[i] as T, i);
      i = next++;
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** RFC-4180 cell: wrap in quotes, double any internal quotes. Newlines stay. */
function csvCell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function toCsv(rows: GuideResult[]): string {
  const header = [
    "slug",
    "name",
    "status",
    "reasoning_tokens",
    "input_tokens",
    "output_tokens",
    "guide",
    "error",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.slug, r.name, r.status, r.reasoningTokens, r.inputTokens, r.outputTokens, r.guide, r.error ?? ""]
        .map(csvCell)
        .join(","),
    );
  }
  // CRLF record separator for spreadsheet friendliness; embedded \n in a quoted
  // guide field is preserved and renders as a multi-line cell.
  return lines.join("\r\n") + "\r\n";
}

function requireKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENAI_API_KEY is not set. In PowerShell:\n" +
        "  $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')",
    );
    process.exit(1);
  }
  return apiKey;
}

function loadSharedBlocks(): { identity: string; formatting: string } {
  const identity = extractBlock(read("packages/engine/src/prompts/dm-identity.md"), "identity");
  const formatting = resolveForGpt(
    extractBlock(read("packages/engine/src/prompts/dm-directives.md"), "formatting"),
  );
  return { identity, formatting };
}

async function runSingle(slug: string): Promise<void> {
  const client = new OpenAI({ apiKey: requireKey() });
  const { identity, formatting } = loadSharedBlocks();

  console.error("=== DM voice-guide generator (single) ===");
  console.error(`personality : ${slug}`);
  console.error(`model       : ${MODEL}   reasoning.effort: ${REASONING_EFFORT}`);
  console.error("calling Responses API (high-effort reasoning — this can take a minute)…\n");

  const r = await generateGuide(client, identity, formatting, slug);
  if (r.error) {
    console.error(`FAILED: ${r.error}`);
    process.exitCode = 1;
    return;
  }

  console.error("--- reasoning ---");
  console.error(
    `reasoning_tokens: ${r.reasoningTokens}${r.reasoningTokens > 0 ? "  ✓ reasoning fired" : "  ✗ NO reasoning"}`,
  );
  console.error(r.summary ? `\nreasoning summary:\n${r.summary}` : "(no reasoning summary text returned)");
  if (r.status === "incomplete") {
    console.error("\n⚠ response incomplete — the visible text may be truncated; raise MAX_OUTPUT_TOKENS.");
  }

  console.log("\n================ VOICE GUIDE ================\n");
  console.log(r.guide);
  console.log("\n============================================");
  console.error(`\nusage: in=${r.inputTokens} out=${r.outputTokens} (reasoning=${r.reasoningTokens}) status=${r.status}`);
}

async function runBatch(): Promise<void> {
  const client = new OpenAI({ apiKey: requireKey() });
  const { identity, formatting } = loadSharedBlocks();

  const slugs = readdirSync(join(repoRoot, "personalities"))
    .filter((f) => f.endsWith(".mvdm"))
    .map((f) => f.replace(/\.mvdm$/, ""))
    .sort();

  const concurrency = Number(process.env.VOICE_GUIDE_CONCURRENCY) || DEFAULT_CONCURRENCY;

  console.error("=== DM voice-guide generator (batch) ===");
  console.error(`seeds       : ${slugs.length}   concurrency: ${concurrency}`);
  console.error(`model       : ${MODEL}   reasoning.effort: ${REASONING_EFFORT}\n`);

  let done = 0;
  const rows = await mapWithConcurrency(slugs, concurrency, async (slug) => {
    const r = await generateGuide(client, identity, formatting, slug);
    done += 1;
    const tag = r.error ? `ERROR ${r.error.slice(0, 60)}` : `${r.status} reasoning=${r.reasoningTokens} chars=${r.guide.length}`;
    console.error(`[${String(done).padStart(2)}/${slugs.length}] ${slug.padEnd(20)} ${tag}`);
    return r;
  });

  const outDir = join(repoRoot, "voice-guides");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "dm-voice-guides.csv");
  writeFileSync(outPath, toCsv(rows), "utf-8");

  const failures = rows.filter((r) => r.error);
  console.error("\n=== summary ===");
  console.error(`ok:     ${rows.length - failures.length}/${rows.length}`);
  if (failures.length > 0) {
    console.error(`failed: ${failures.map((f) => f.slug).join(", ")}`);
  }
  // stdout carries the artifact path so it's easy to capture programmatically.
  console.log(outPath);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "all") {
    await runBatch();
  } else {
    await runSingle(arg ?? "the-crossroads");
  }
}

main().catch((e: unknown) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
