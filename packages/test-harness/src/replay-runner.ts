/**
 * Replay a full-stack golden against a running MachineViolet — the deterministic
 * packaged-artifact gate.
 *
 * Boots the app (from source, or a packaged binary via `opts.executable`) with
 * the replay knobs set — `MV_E2E=1` (synthetic connection → menu unlocks),
 * `MV_TAPE_MODE=replay` + `MV_TAPE_PATH` (every tier served from the tape, no
 * network/key), `MV_CONFIG_DIR` (a throwaway temp dir, hermetic) — then re-issues
 * the golden's captured `inputs` in order and asserts the DM narration matches
 * `expectedNarrative`.
 *
 * Because the tape makes setup + DM deterministic and navigation keystrokes
 * never reach the engine (only the submitted text/choice does), the same inputs
 * reproduce the same session on any platform. The per-input settle waits for the
 * engine to return to `waiting_input` with fresh narrative — which naturally
 * waits out the long finalize→handoff→opening on the setup-confirm turn.
 *
 * See docs/e2e-harness.md.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Harness } from "./harness.js";
import { choiceLabel, type ActiveChoices, type ClientStateSnapshot } from "./client-state.js";
import type { FullStackGolden, RecordedInput } from "./golden.js";
import { DEFAULT_TURN_TIMEOUT_MS } from "./wait.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function choiceFp(c: ActiveChoices): string {
  return (c.prompt ?? "") + "::" + c.choices.map(choiceLabel).join("|");
}

function dmLines(s: ClientStateSnapshot): string[] {
  return s.narrativeLines.filter((l) => l.kind === "dm").map((l) => l.text);
}

export interface ReplayOptions {
  /** Spawn the packaged binary instead of the from-source launcher. */
  executable?: { command: string; args?: string[] };
  player?: string;
  /** Per-input settle timeout. Default 120s — replay is offline, but handoff
   *  world-build does real filesystem work; generous but finite. */
  turnTimeoutMs?: number;
  stdio?: "inherit" | "buffer" | "ignore";
}

export interface ReplayResult {
  scenario: string;
  ok: boolean;
  expected: string[];
  actual: string[];
  /** First char index where the NORMALIZED narratives diverge, or -1 if equal. */
  divergeAt: number;
  error?: string;
  /** Tail of child output on failure, for diagnostics. */
  childLogTail?: string;
}

/**
 * Collapse DM lines to a whitespace-insensitive string. Replay reproduces the
 * verbatim streamed text (deltas), but line SEGMENTATION around tool-call flush
 * boundaries is a streaming artifact we don't reproduce byte-for-byte — so we
 * compare content, not line breaks. Joining with "" then collapsing whitespace
 * makes a split ("A","B") and a merge ("AB") of the same underlying text equal,
 * while any real content/order/missing-text difference still shows.
 */
export function normalizeNarrative(lines: string[]): string {
  return lines.join("").replace(/\s+/g, " ").trim();
}

export async function replayGolden(golden: FullStackGolden, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const turnTimeoutMs = opts.turnTimeoutMs ?? Math.max(DEFAULT_TURN_TIMEOUT_MS, 120_000);
  const work = await mkdtemp(join(tmpdir(), "mv-replay-"));
  const tapePath = join(work, "tape.json");
  const configDir = join(work, "config");
  const campaignsDir = join(work, "campaigns");
  // The runtime reads MV_TAPE_PATH as a bare serialized Tape; extract it from
  // the golden envelope (the envelope shape is a harness-only concern).
  await writeFile(tapePath, JSON.stringify(golden.tape) + "\n");
  await mkdir(configDir, { recursive: true });

  let harness: Harness | undefined;
  let actual: string[] = [];
  try {
    harness = await Harness.launch({
      env: {
        MV_E2E: "1",
        MV_TAPE_MODE: "replay",
        MV_TAPE_PATH: tapePath,
        MV_CONFIG_DIR: configDir,
      },
      campaignsDir,
      player: opts.player ?? "TestPlayer",
      executable: opts.executable,
      stdio: opts.stdio ?? "buffer",
    });

    // The synthetic connection unlocks "New Campaign" in the menu.
    await harness.waitForScreen("New Campaign", { timeoutMs: 30_000, description: "main menu" });

    for (const input of golden.inputs) {
      await replayInput(harness, input, turnTimeoutMs);
    }

    actual = dmLines(await harness.getState());
  } catch (err) {
    return {
      scenario: golden.scenario,
      ok: false,
      expected: golden.expectedNarrative,
      actual,
      divergeAt: -1,
      error: err instanceof Error ? err.message : String(err),
      childLogTail: harness?.childLogTail(40),
    };
  } finally {
    if (harness) await harness.shutdown();
    await rm(work, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }

  const expNorm = normalizeNarrative(golden.expectedNarrative);
  const actNorm = normalizeNarrative(actual);
  const divergeAt = firstCharDiff(expNorm, actNorm);
  return { scenario: golden.scenario, ok: divergeAt === -1, expected: golden.expectedNarrative, actual, divergeAt };
}

const dmCount = (s: ClientStateSnapshot): number => s.narrativeLines.filter((l) => l.kind === "dm").length;
const playerCount = (s: ClientStateSnapshot): number => s.narrativeLines.filter((l) => l.kind === "player").length;

async function replayInput(h: Harness, input: RecordedInput, turnTimeoutMs: number): Promise<void> {
  const before = await h.getState();
  const baseDm = dmCount(before);
  const basePlayer = playerCount(before);
  const baselineFp = before.activeChoices ? choiceFp(before.activeChoices) : null;

  switch (input.kind) {
    case "key": {
      await h.sendKey(input.name);
      // Only return/enter can start engine work (menu select → setup). Probe
      // briefly; if work began, settle. Other keys are pure UI nav.
      if (input.name === "return" || input.name === "enter") {
        if (await workStarted(h, baseDm, baselineFp, 6_000)) {
          await settle(h, baseDm, baselineFp, turnTimeoutMs);
        }
      } else {
        await delay(150);
      }
      return;
    }
    case "say": {
      // Mirror session-driver.say: if a choice overlay is up, move to the
      // "Enter your own" custom row before typing.
      const submit = async () => {
        const s = await h.getState();
        if (s.activeChoices) { await h.sendKey("up"); await delay(60); }
        await h.sendText(input.text);
        await delay(60);
        await h.sendKey("return");
      };
      await submitWithRetry(h, submit, basePlayer);
      await settle(h, baseDm, baselineFp, turnTimeoutMs);
      return;
    }
    case "pick": {
      // Mirror session-driver.pick: UP to the custom row, DOWN to the first
      // real choice, DOWN*index to the target, then select. The exact path is
      // immaterial to the engine — only the landed choice is submitted.
      const submit = async () => {
        await h.sendKey("up"); await delay(50);
        await h.sendKey("down");
        for (let i = 0; i < input.index; i++) { await delay(50); await h.sendKey("down"); }
        await delay(50);
        await h.sendKey("return");
      };
      await submitWithRetry(h, submit, basePlayer);
      await settle(h, baseDm, baselineFp, turnTimeoutMs);
      return;
    }
  }
}

/**
 * Submit an input and confirm it registered, retrying once on a drop. say/pick
 * can land in the brief window where the previous turn's scribe is still
 * finalizing and a stray re-render swallows the keystrokes — the optimistic
 * player echo never appears. Mirrors session-driver.say's guard. Keyed on the
 * player-line count (not total narrative) so the previous turn's lingering
 * detached-scribe `dev` lines can't be mistaken for acknowledgement.
 */
async function submitWithRetry(h: Harness, submit: () => Promise<void>, basePlayer: number): Promise<void> {
  await submit();
  if (await inputAccepted(h, basePlayer, 4_000)) return;
  await h.sendKey("ctrl+u"); // clear any partial buffer, then resend
  await delay(80);
  await submit();
  await inputAccepted(h, basePlayer, 4_000);
}

/** True once the engine echoes the input as a new player line (or starts thinking). */
async function inputAccepted(h: Harness, basePlayer: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await h.getState();
      if (
        playerCount(s) > basePlayer ||
        s.engineState === "dm_thinking" ||
        s.engineState === "starting_session"
      ) return true;
    } catch { /* sidecar momentarily busy */ }
    await delay(300);
  }
  return false;
}

/** Poll briefly for any sign the last input started engine work. */
async function workStarted(
  h: Harness,
  baseDm: number,
  baselineFp: string | null,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let s: ClientStateSnapshot;
    try { s = await h.getState(); } catch { await delay(150); continue; }
    const fp = s.activeChoices ? choiceFp(s.activeChoices) : null;
    if (
      dmCount(s) > baseDm ||
      (fp !== null && fp !== baselineFp) ||
      s.transitionCampaignId != null ||
      (s.engineState != null && s.engineState !== "waiting_input")
    ) {
      return true;
    }
    await delay(200);
  }
  return false;
}

/**
 * Wait until the engine settles back to waiting_input with a fresh DM line (or
 * a new choice overlay) — the next beat the player would react to. Keyed on
 * `dm` lines specifically: the previous turn's detached scribe keeps appending
 * `dev` breadcrumbs after the turn settles, and counting those as "the beat"
 * would let the next input fire before its DM response actually lands.
 */
async function settle(
  h: Harness,
  baseDm: number,
  baselineFp: string | null,
  timeoutMs: number,
): Promise<void> {
  await h.waitForState(
    (s) => {
      const dmAdvanced = s.engineState === "waiting_input" && dmCount(s) > baseDm;
      const fp = s.activeChoices ? choiceFp(s.activeChoices) : null;
      const choicesAdvanced = fp !== null && fp !== baselineFp;
      return dmAdvanced || choicesAdvanced;
    },
    { timeoutMs, pollMs: 250, description: "beat after input" },
  );
}

function firstCharDiff(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}
