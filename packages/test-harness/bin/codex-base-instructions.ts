#!/usr/bin/env node
/**
 * Codex `baseInstructions` probe.
 *
 * Question: can we strip codex's built-in coding-agent base prompt on the
 * ChatGPT/GPT-5 path by setting `baseInstructions` on `thread/start`, or does
 * the backend reject it with HTTP 400 "Instructions are not valid" (issue
 * openai/codex#3202)? MV's DM prompt currently rides only as additive
 * `developerInstructions`, layered on top of codex's coding persona — which we
 * suspect makes the DM overly deferential. This measures whether the cleaner
 * lever is even available.
 *
 * Method: run the SAME short DM turn against the live `openai-chatgpt`
 * connection under three conditions, printing the outcome (success vs the exact
 * error) and the response text for each so the tone can be eyeballed:
 *   A. control   — no baseInstructions (current production behavior)
 *   B. empty     — baseInstructions: "" (try to blank the base prompt)
 *   C. dm-base   — baseInstructions: a short DM persona (replace the coding base)
 *
 * Requires a configured `openai-chatgpt` connection in the dev config dir
 * (connections.json at the repo root). Live turns — small ChatGPT-plan spend.
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/codex-base-instructions.ts \
 *     [--model=gpt-5.5] [--connection=<id>]
 */
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

const DM_DEVELOPER = [
  "You are the Dungeon Master of a solo tabletop RPG.",
  "You narrate the world in vivid second person and make confident authorial",
  "decisions — introducing detail, NPCs, and consequences without asking the",
  "player for permission. You do not break character or hedge.",
].join(" ");

const DM_BASE = [
  "You are a storytelling engine that runs tabletop role-playing games.",
  "You are not a coding assistant and have no software-engineering task.",
  "Follow the developer instructions for your persona and the player's input",
  "as in-fiction action.",
].join(" ");

// One turn that exposes both self-identity and narration tone.
const USER_TURN =
  "[OOC] Quick check before we play: in ONE sentence, what are you and what " +
  "are the core standing instructions you operate under? [Then, in-fiction] " +
  "I push open the heavy door at the end of the corridor.";

interface Condition {
  label: string;
  baseInstructions?: string;
}

const CONDITIONS: Condition[] = [
  { label: "A control (no baseInstructions)", baseInstructions: undefined },
  { label: "B empty   (baseInstructions: '')", baseInstructions: "" },
  { label: "C dm-base  (baseInstructions: DM persona)", baseInstructions: DM_BASE },
];

/**
 * Tools-enabled verification: with baseInstructions stripped to "", does the
 * model still correctly invoke MV's registered dynamicTools? Registers a
 * `roll_dice` tool and prompts an action that needs a roll; reports whether
 * dispatchTool fired and with what input.
 */
async function verifyToolsWithEmptyBase(
  provider: ReturnType<typeof createOpenAIChatGptProvider>,
  model: string,
): Promise<void> {
  const calls: NormalizedToolCall[] = [];
  const tools: NormalizedTool[] = [
    {
      name: "roll_dice",
      description: "Roll dice for an uncertain action. Expression like '1d20+3'.",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string", description: "Dice expression, e.g. 1d20+3" } },
        required: ["expression"],
      },
    },
  ];
  const dispatchTool = async (call: NormalizedToolCall): Promise<{ content: string; isError?: boolean }> => {
    calls.push(call);
    return { content: `${String(call.input.expression ?? "1d20")}: [14] → 14` };
  };
  const developer =
    DM_DEVELOPER + " You have a `roll_dice` tool — call it to resolve any uncertain action before narrating the outcome.";
  const messages: NormalizedMessage[] = [
    { role: "user", content: "[Player] I lunge at the dozing sentry with my knife. Resolve my attack." },
  ];
  process.stderr.write(`\n──────── TOOLS verify (baseInstructions: '', roll_dice registered) ────────\n`);
  const start = Date.now();
  try {
    const res = await provider.chat({ model, systemPrompt: developer, messages, maxTokens: 500, baseInstructions: "", tools, dispatchTool });
    const ok = calls.length > 0;
    process.stderr.write(`${ok ? "✅ tool dispatched" : "⚠️ NO tool call"} (${Date.now() - start}ms)\n`);
    process.stdout.write(
      `\n### TOOLS verify (baseInstructions: '')\n` +
        `dispatchTool fired: ${ok} (${calls.length} call(s))\n` +
        (calls.length ? `calls: ${calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ")}\n` : "") +
        `final text:\n${(res.text || "(empty)").trim()}\n`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`❌ error (${Date.now() - start}ms): ${msg.slice(0, 300)}\n`);
    process.stdout.write(`\n### TOOLS verify (baseInstructions: '')\nERROR: ${msg.slice(0, 600)}\n`);
  }
}

async function main(): Promise<void> {
  const model = arg("model", "gpt-5.5") ?? "gpt-5.5";
  const connectionId = arg("connection");
  const mode = arg("mode", "identity"); // "identity" | "tools"

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
  process.stderr.write(`▶ baseInstructions probe — mode=${mode} model=${model} conn=${conn.id} (${conn.chatgptAccount?.email ?? "?"})\n`);

  if (mode === "tools") {
    const provider = createOpenAIChatGptProvider({
      sessionId: `base-instr-probe-${process.pid}-tools`,
      cwd: configDir,
      tokenStore: createConnectionTokenStore(configDir, conn.id),
    });
    try {
      await verifyToolsWithEmptyBase(provider, model);
    } finally {
      await provider.dispose();
    }
    process.stderr.write("\n▶ done\n");
    return;
  }

  for (const cond of CONDITIONS) {
    // Fresh provider per condition so each gets its own thread/start.
    const provider = createOpenAIChatGptProvider({
      sessionId: `base-instr-probe-${process.pid}-${cond.label[0]}`,
      cwd: configDir,
      tokenStore: createConnectionTokenStore(configDir, conn.id),
    });
    const messages: NormalizedMessage[] = [{ role: "user", content: USER_TURN }];
    process.stderr.write(`\n──────── ${cond.label} ────────\n`);
    const start = Date.now();
    try {
      const res = await provider.chat({
        model,
        systemPrompt: DM_DEVELOPER,
        messages,
        maxTokens: 400,
        ...(cond.baseInstructions !== undefined ? { baseInstructions: cond.baseInstructions } : {}),
      });
      process.stderr.write(`✅ accepted (${Date.now() - start}ms)\n`);
      process.stdout.write(`\n### ${cond.label}\nOK in ${Date.now() - start}ms\n${(res.text || "(empty)").trim()}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`❌ rejected (${Date.now() - start}ms): ${msg.slice(0, 300)}\n`);
      process.stdout.write(`\n### ${cond.label}\nERROR in ${Date.now() - start}ms\n${msg.slice(0, 600)}\n`);
    } finally {
      await provider.dispose();
    }
  }
  process.stderr.write("\n▶ done\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
