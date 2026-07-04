#!/usr/bin/env node
/**
 * CODEX_HOME isolation probe.
 *
 * Two questions, both about the `code=1 / (code: 1546) disk I/O error` crash
 * that killed codex when multiple subprocesses shared one `~/.codex` SQLite
 * state runtime (root-caused from `.debug/engine.jsonl`: a 4-wide simultaneous
 * spawn against one home killed all four; staggered spawns never did):
 *
 *   A. AUTH — does a codex subprocess pointed at a FRESH, EMPTY `CODEX_HOME`
 *      (no `auth.json`) still authenticate? Theory: yes, because MV pushes
 *      ChatGPT tokens over RPC (`pushChatGptAuthTokens`), not from disk. This
 *      is the assumption the whole isolation fix rests on — verify it live
 *      before relying on it.
 *
 *   B. NO-CRASH — spawn N providers CONCURRENTLY, each with its OWN isolated
 *      home, and run a turn on each. This is the exact scenario that crashed
 *      4/4 on a shared home. With isolation it must go N/N.
 *
 * Requires a configured `openai-chatgpt` connection in the dev config dir
 * (connections.json at the repo root). Live turns — small ChatGPT-plan spend
 * (N+1 tiny turns).
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/codex-home-isolation.ts \
 *     [--model=gpt-5.5] [--connection=<id>] [--n=4]
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir } from "node:fs/promises";

import { createOpenAIChatGptProvider } from "../../engine/src/providers/index.js";
import { createConnectionTokenStore } from "../../engine/src/providers/openai-chatgpt/index.js";
import type { NormalizedMessage } from "../../engine/src/providers/types.js";
import { loadConnectionStore } from "../../engine/src/config/connections.js";
import { initEngineLog } from "../../engine/src/context/engine-log.js";
import { REPO_ROOT, findConfigDir } from "../src/launch-env.js";

function arg(name: string, dflt?: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const USER_TURN =
  "[OOC] One-word reply only: say the word ONLINE. [Then in-fiction] I nod.";

interface RunOutcome {
  label: string;
  home: string;
  ok: boolean;
  ms: number;
  text?: string;
  error?: string;
  /** Files present in the home AFTER the turn — proves codex initialized state there. */
  homeContents?: string[];
}

async function runOneTurn(opts: {
  label: string;
  model: string;
  configDir: string;
  connId: string;
  home: string;
}): Promise<RunOutcome> {
  const { label, model, configDir, connId, home } = opts;
  const provider = createOpenAIChatGptProvider({
    sessionId: `codex-home-probe-${process.pid}-${label}`,
    cwd: configDir,
    tokenStore: createConnectionTokenStore(configDir, connId),
    codexHome: home,
  });
  const messages: NormalizedMessage[] = [{ role: "user", content: USER_TURN }];
  const start = Date.now();
  try {
    const res = await provider.chat({ model, systemPrompt: "You are a terse test fixture.", messages, maxTokens: 200 });
    // Peek at the home BEFORE dispose removes it, to confirm codex wrote its
    // state runtime here (isolation actually took) and not into ~/.codex.
    let homeContents: string[] | undefined;
    try { homeContents = await readdir(home); } catch { homeContents = undefined; }
    return { label, home, ok: true, ms: Date.now() - start, text: (res.text || "(empty)").trim().slice(0, 120), homeContents };
  } catch (e) {
    return { label, home, ok: false, ms: Date.now() - start, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    // dispose() removes the home itself when we passed codexHome; the mkdtemp
    // parent is separate, so nothing leaks.
    await provider.dispose();
  }
}

async function main(): Promise<void> {
  const model = arg("model", "gpt-5.5") ?? "gpt-5.5";
  const connectionId = arg("connection");
  const n = Math.max(1, Number(arg("n", "4")));

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
  process.stderr.write(`▶ CODEX_HOME isolation probe — model=${model} conn=${conn.id} (${conn.chatgptAccount?.email ?? "?"}) n=${n}\n`);

  // Each run gets a fresh, empty home under a temp parent. mkdtemp guarantees
  // uniqueness; the dir starts with NO auth.json, so success proves RPC auth.
  const parent = await mkdtemp(join(tmpdir(), "mv-codex-iso-"));
  try {
    // --- Part A: single isolated turn (the auth question) ---
    const homeA = await mkdtemp(join(parent, "solo-"));
    process.stderr.write(`\n──────── A. single isolated home (auth) ────────\n  home: ${homeA}\n`);
    const a = await runOneTurn({ label: "A-solo", model, configDir, connId: conn.id, home: homeA });
    process.stderr.write(a.ok ? `✅ auth OK, turn completed (${a.ms}ms)\n` : `❌ ${a.error} (${a.ms}ms)\n`);
    if (a.homeContents) process.stderr.write(`  home wrote: ${a.homeContents.join(", ") || "(empty)"}\n`);

    // --- Part B: N concurrent isolated turns (the crash scenario) ---
    process.stderr.write(`\n──────── B. ${n}× concurrent, each its own home (no-crash) ────────\n`);
    const homes = await Promise.all(
      Array.from({ length: n }, (_v, i) => mkdtemp(join(parent, `conc-${i}-`))),
    );
    const results = await Promise.all(
      homes.map((home, i) => runOneTurn({ label: `B-${i}`, model, configDir, connId: conn.id, home })),
    );
    const passed = results.filter((r) => r.ok).length;
    for (const r of results) {
      process.stderr.write(`  ${r.ok ? "✅" : "❌"} ${r.label} (${r.ms}ms)${r.error ? " — " + r.error : ""}\n`);
    }

    // --- Report ---
    process.stdout.write(
      `\n### CODEX_HOME isolation probe\n` +
        `model=${model} conn=${conn.id}\n\n` +
        `A. single isolated home (auth): ${a.ok ? "PASS — authenticated from an empty home" : "FAIL"}\n` +
        (a.ok ? `   reply: ${a.text}\n   home contents after turn: ${a.homeContents?.join(", ") || "(none)"}\n` : `   error: ${a.error}\n`) +
        `\nB. ${n}× concurrent isolated homes (no-crash): ${passed}/${n} PASS` +
        `${passed === n ? " — isolation eliminates the shared-home crash" : " — SOME FAILED (see stderr)"}\n`,
    );
    process.stderr.write(`\n▶ done — A:${a.ok ? "PASS" : "FAIL"} B:${passed}/${n}\n`);
  } finally {
    await rm(parent, { recursive: true, force: true }).catch(() => { /* temp parent cleanup is best-effort */ });
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
