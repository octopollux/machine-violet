#!/usr/bin/env node
/**
 * DM voice-guide generator (personality-prior authoring tool).
 *
 * Asks the DM — primed with the real Core DM Identity, a chosen DM personality
 * block, and the live formatting rules — to write a short guide, IN ITS OWN
 * VOICE, describing how it speaks and what it says, with examples. The intent
 * is to fold that output back into the personality block as a deeper,
 * example-rich voice prior: showing the model its own voice beats describing it.
 *
 * We deliberately drive GPT-5.5 rather than Claude. Its personality vector is
 * softer, so it adopts an authored voice more readily and with less of the
 * assistant register bleeding through — which is the whole point of seeding a
 * stronger prior with minimal harness/assistant interference.
 *
 * Standalone on purpose: this talks to the OpenAI SDK's Responses API directly
 * rather than going through the engine's provider stack, so there's nothing to
 * fight when iterating on the prompt. Reasoning is requested at HIGH effort and
 * the run prints the reasoning-token count (and any summary) as proof it fired.
 *
 * Run (PowerShell — the key lives in the User-scope env on this box):
 *
 *   $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')
 *   node --import tsx/esm packages/test-harness/bin/dm-voice-guide.ts [personality-slug]
 *
 * `personality-slug` defaults to `the-crossroads` and names a file under
 * `personalities/<slug>.mvdm`.
 *
 * Diagnostics go to stderr, the guide itself to stdout — so you can redirect
 * stdout to a file and keep the run log separate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import OpenAI from "openai";

const MODEL = "gpt-5.5";
const REASONING_EFFORT = "high" as const;
// Ceiling, not a target. High-effort reasoning tokens count against the output
// budget, so leave generous headroom above the ~few-hundred-token guide so the
// visible text is never starved by the thinking pass.
const MAX_OUTPUT_TOKENS = 16_000;

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

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "the-crossroads";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENAI_API_KEY is not set. In PowerShell:\n" +
        "  $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')",
    );
    process.exit(1);
  }

  const identity = extractBlock(read("packages/engine/src/prompts/dm-identity.md"), "identity");
  const formatting = resolveForGpt(
    extractBlock(read("packages/engine/src/prompts/dm-directives.md"), "formatting"),
  );
  const personality = loadPersonality(slug);
  const persona = personalityBlock(personality);

  // System prefix mirrors how the real DM is primed: identity + personality +
  // formatting are all part of the cached system prefix; the writing request
  // is the turn. Repeating the persona as a closing "Reminder:" in the turn
  // reinforces the voice right before generation.
  const instructions = [identity, persona, formatting].join("\n\n");
  const task = [
    "You are writing a guide to pass along your personality to another agent. " +
      "Write 2-3 paragraphs *in your own voice* describing how you speak and what you say, with examples. " +
      "It is more important that it be idiomatic and full of personality than it be technically sound.",
    "",
    "Reminder:",
    persona,
  ].join("\n");

  console.error("=== DM voice-guide generator ===");
  console.error(`personality : ${personality.name} (${slug})`);
  console.error(`model       : ${MODEL}   reasoning.effort: ${REASONING_EFFORT}`);
  console.error(`instructions: ${instructions.length} chars   task: ${task.length} chars`);
  console.error("calling Responses API (high-effort reasoning — this can take a minute)…\n");

  const client = new OpenAI({ apiKey });

  // Primary attempt asks for a reasoning summary. Some orgs gate summaries
  // behind verification; if that's the only complaint, retry without it — the
  // reasoning_tokens count still proves reasoning ran.
  async function call(withSummary: boolean) {
    return client.responses.create({
      model: MODEL,
      instructions,
      input: task,
      reasoning: withSummary
        ? { effort: REASONING_EFFORT, summary: "auto" }
        : { effort: REASONING_EFFORT },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
    });
  }

  let response;
  try {
    response = await call(true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/summary|verif/i.test(msg)) {
      console.error(`(reasoning summary rejected — retrying without it: ${msg})\n`);
      response = await call(false);
    } else {
      throw e;
    }
  }

  // --- Prove reasoning ran -------------------------------------------------
  const reasoningTokens = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  const summaries: string[] = [];
  for (const item of response.output) {
    if (item.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (s.type === "summary_text" && s.text) summaries.push(s.text);
      }
    }
  }

  console.error("--- reasoning ---");
  console.error(`reasoning_tokens: ${reasoningTokens}${reasoningTokens > 0 ? "  ✓ reasoning fired" : "  ✗ NO reasoning"}`);
  if (summaries.length > 0) {
    console.error("\nreasoning summary:\n" + summaries.join("\n\n"));
  } else {
    console.error("(no reasoning summary text returned)");
  }

  if (response.status === "incomplete") {
    console.error(
      `\n⚠ response incomplete (${response.incomplete_details?.reason ?? "unknown"}) — ` +
        "the visible text may be truncated; raise MAX_OUTPUT_TOKENS.",
    );
  }

  // --- The guide -----------------------------------------------------------
  console.log("\n================ VOICE GUIDE ================\n");
  console.log(response.output_text.trim());
  console.log("\n============================================");

  console.error(
    `\nusage: in=${response.usage?.input_tokens ?? 0} out=${response.usage?.output_tokens ?? 0} ` +
      `(reasoning=${reasoningTokens}) status=${response.status}`,
  );
}

main().catch((e: unknown) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
