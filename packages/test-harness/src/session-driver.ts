/**
 * Persistent interactive play session — the thing a coding agent uses to
 * *play* Machine Violet turn-for-turn, not just run a scripted probe.
 *
 * The difference from {@link Harness}: Harness spawns the launcher, runs one
 * scripted body, then hard-kills the process. Nothing survives between an
 * agent's tool calls. This driver instead spawns the launcher+sidecar as a
 * **detached** background process that outlives the launching command, records
 * a small session file under the system temp dir, and exposes one-shot
 * operations (`start`, `screen`, `state`, `say`, `pick`, `key`, `wait`,
 * `stop`) that each run as their own short-lived CLI invocation and talk to
 * the already-running sidecar over HTTP.
 *
 * That maps cleanly onto how an agent operates: one tool call = one operation.
 * The slow part (waiting through a 1-5 minute DM turn) is `wait`, which polls
 * until the game settles and then exits — so the agent can run it with
 * `run_in_background` and be re-invoked when the DM is done.
 *
 * Read-back is over the sidecar's HTTP `/screen` + `/state` (non-blocking;
 * there is no stdin/stdout pipe to block on). The detached launcher's own
 * stdout/stderr is also tee'd to a log file for crash diagnostics.
 *
 * State the agent has "seen" is tracked in the session file as a read cursor
 * (narrative-line count) plus the last choice-overlay fingerprint, so
 * `wait`/`narrative` can show only what's new and `wait` can tell a genuine
 * new beat from a stale overlay lingering on screen.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { buildLaunchEnv, pickEphemeralPort, LAUNCHER_NODE_ARGS } from "./launch-env.js";
import { choiceLabel, type ClientStateSnapshot, type ActiveChoices } from "./client-state.js";

// ---------------------------------------------------------------------------
// Session file
// ---------------------------------------------------------------------------

/** One interactive session at a time, under the system temp dir. */
export const SESSION_DIR = join(tmpdir(), "mvplay");
const SESSION_FILE = join(SESSION_DIR, "session.json");
const LAUNCHER_LOG = join(SESSION_DIR, "launcher.log");
const CAMPAIGNS_DIR = join(SESSION_DIR, "campaigns");

interface SessionFile {
  pid: number;
  serverPort: number;
  agentPort: number;
  campaignsDir: string;
  launcherLog: string;
  player: string;
  launchedAt: number;
  /** narrativeLines.length the agent has already been shown. */
  readCursor: number;
  /** Fingerprint of the last choice overlay the agent acted on (say/pick). */
  lastChoiceFp: string | null;
  /** currentTurn.seq the agent last observed open (for turn-open detection). */
  lastTurnSeq: number | null;
  /** currentTurn.campaignId the agent last observed (handoff detection). */
  lastCampaignId: string | null;
  /** Tape scenario name if this session is recording (MV_TAPE_MODE=record), else null. */
  recording: string | null;
}

function readSession(): SessionFile | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

function writeSession(s: SessionFile): void {
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function requireSession(): SessionFile {
  const s = readSession();
  if (!s) {
    throw new Error(
      "No mvplay session. Run `mvplay start` first.",
    );
  }
  return s;
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but not ours (still "alive").
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    // Kill the whole tree, otherwise any engine subprocess can linger.
    const r = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    r.on("error", () => { /* best-effort */ });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Sidecar HTTP
// ---------------------------------------------------------------------------

function sidecar(s: SessionFile): string {
  return `http://127.0.0.1:${s.agentPort}`;
}

async function getState(s: SessionFile): Promise<ClientStateSnapshot> {
  let res: Response;
  try {
    res = await fetch(`${sidecar(s)}/state`);
  } catch (err) {
    throw new Error(
      `Could not reach the session sidecar on port ${s.agentPort}. ` +
      `The launcher may have crashed — check \`mvplay log\`.`,
      { cause: err },
    );
  }
  if (!res.ok) throw new Error(`/state returned ${res.status}`);
  return (await res.json()) as ClientStateSnapshot;
}

async function getScreen(s: SessionFile, ansi = false): Promise<string> {
  const res = await fetch(`${sidecar(s)}/screen${ansi ? "?ansi=true" : ""}`);
  if (!res.ok) throw new Error(`/screen returned ${res.status}`);
  return await res.text();
}

async function postKey(s: SessionFile, key: string): Promise<void> {
  const res = await fetch(`${sidecar(s)}/input/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`key(${key}) failed: ${res.status} ${body}`);
  }
}

async function postText(s: SessionFile, text: string): Promise<void> {
  const res = await fetch(`${sidecar(s)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: text,
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`input failed: ${res.status} ${body}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Confirm that a just-submitted input actually registered. The client adds an
 * optimistic player line the instant it accepts the keystrokes, so a grown
 * narrative length (or the engine starting to think) is fast, reliable proof.
 *
 * This guards against a real race: `say`/`pick` can land in the brief window
 * where the previous turn's scribe subagent is still finalizing and a stray
 * re-render drops the keystrokes. The engine still reports `waiting_input`, so
 * state alone can't tell — but the missing optimistic line can.
 */
async function inputAccepted(s: SessionFile, baselineLines: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await getState(s);
      if (
        st.narrativeLines.length > baselineLines ||
        st.engineState === "dm_thinking" ||
        st.engineState === "starting_session"
      ) {
        return true;
      }
    } catch { /* sidecar momentarily busy */ }
    await sleep(300);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Choice + state formatting
// ---------------------------------------------------------------------------

function choiceFp(c: ActiveChoices): string {
  return (c.prompt ?? "") + "::" + c.choices.map(choiceLabel).join("|");
}

function formatChoices(c: ActiveChoices): string {
  const lines: string[] = [];
  if (c.prompt) lines.push(`  ${c.prompt}`);
  c.choices.forEach((choice, i) => {
    lines.push(`    ${i + 1}. ${choiceLabel(choice)}`);
  });
  return lines.join("\n");
}

function formatNarrative(lines: ClientStateSnapshot["narrativeLines"], from: number): string {
  return lines
    .slice(from)
    .map((l) => {
      const tag = l.kind === "dm" ? "DM" : l.kind === "player" ? "YOU" : l.kind.toUpperCase();
      return `[${tag}] ${l.text}`;
    })
    .join("\n");
}

function summarizeState(s: ClientStateSnapshot, readCursor: number): string {
  const out: string[] = [];
  out.push(`engine: ${s.engineState ?? "(null)"}   mode: ${s.mode}`);
  if (s.currentTurn) {
    out.push(
      `turn: campaign=${s.currentTurn.campaignId ?? "?"} seq=${s.currentTurn.seq} status=${s.currentTurn.status}`,
    );
  } else {
    out.push("turn: (none open)");
  }
  if (s.transitionCampaignId) {
    out.push(`handoff in progress → ${s.transitionCampaignName ?? s.transitionCampaignId}`);
  }
  if (s.activeChoices) {
    out.push("choices:");
    out.push(formatChoices(s.activeChoices));
  }
  out.push(`narrative: ${s.narrativeLines.length} lines (seen ${readCursor})`);
  if (s.lastError) {
    out.push(`error: ${s.lastError.message} (recoverable=${s.lastError.recoverable})`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface StartOptions {
  player?: string;
  /** Stop and replace an existing live session instead of erroring. */
  fresh?: boolean;
  /** Max ms to wait for the sidecar to come up. Default 30s. */
  launchTimeoutMs?: number;
  /**
   * Record a session tape under this scenario name (sets `MV_TAPE_MODE=record`
   * + `MV_TAPE_SCENARIO` on the launcher). Pull the tape afterward with
   * `saveTape()`. Omit for a normal play session.
   */
  record?: string;
}

/**
 * Spawn the detached launcher+sidecar and wait until it's reachable. Writes
 * the session file. Prints a ready line, the agent port, and the opening
 * screen (the main menu).
 */
export async function start(opts: StartOptions = {}): Promise<void> {
  const existing = readSession();
  if (existing && isAlive(existing.pid)) {
    if (!opts.fresh) {
      throw new Error(
        `A session is already running (pid ${existing.pid}, port ${existing.agentPort}). ` +
        `Use \`mvplay stop\` first, or \`mvplay start --fresh\` to replace it.`,
      );
    }
    killTree(existing.pid);
    // Give Windows taskkill a beat to release the ports.
    await sleep(500);
  }

  mkdirSync(SESSION_DIR, { recursive: true });
  mkdirSync(CAMPAIGNS_DIR, { recursive: true });

  const serverPort = pickEphemeralPort();
  let agentPort = pickEphemeralPort();
  // Distinct ports — a collision would make the second listener fail to bind
  // (or the sidecar check attach to the engine). 1-in-10000, but cheap to rule out.
  while (agentPort === serverPort) agentPort = pickEphemeralPort();
  const player = opts.player ?? "Player";
  const launchedAt = Date.now();

  const { env, cwd } = buildLaunchEnv({
    serverPort,
    agentPort,
    campaignsDir: CAMPAIGNS_DIR,
    player,
    extraEnv: opts.record
      ? { MV_TAPE_MODE: "record", MV_TAPE_SCENARIO: opts.record }
      : undefined,
  });

  // Detached: the child must outlive THIS cli process. Its stdout/stderr go
  // to a log file (we have no live pipe to read once we exit). stdin is
  // ignored — the sidecar injects keystrokes via a mock TTY, not our stdin.
  const logFd = openSync(LAUNCHER_LOG, "w");
  const child = spawn(process.execPath, [...LAUNCHER_NODE_ARGS], {
    env,
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd);

  if (child.pid === undefined) {
    throw new Error("Failed to spawn launcher (no pid).");
  }

  const session: SessionFile = {
    pid: child.pid,
    serverPort,
    agentPort,
    campaignsDir: CAMPAIGNS_DIR,
    launcherLog: LAUNCHER_LOG,
    player,
    launchedAt,
    readCursor: 0,
    lastChoiceFp: null,
    lastTurnSeq: null,
    lastCampaignId: null,
    recording: opts.record ?? null,
  };

  // Wait for the sidecar to answer.
  const timeoutMs = opts.launchTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      const tail = tailFile(LAUNCHER_LOG, 30);
      throw new Error(
        `Launcher exited before the sidecar came up. Recent log:\n${tail}`,
      );
    }
    try {
      const r = await fetch(`http://127.0.0.1:${agentPort}/state`);
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!ready) {
    killTree(child.pid);
    throw new Error(
      `Sidecar did not become reachable on port ${agentPort} within ${timeoutMs}ms. ` +
      `Log tail:\n${tailFile(LAUNCHER_LOG, 30)}`,
    );
  }

  writeSession(session);

  process.stdout.write(`✔ session started (pid ${child.pid}, sidecar :${agentPort})\n`);
  if (opts.record) {
    process.stdout.write(
      `● recording tape "${opts.record}" — play the scenario, then \`mvplay save-tape <path>\`.\n`,
    );
  }
  process.stdout.write("\n");
  const screen = await getScreen(session);
  process.stdout.write(screen.replace(/\n+$/, "") + "\n");
  process.stdout.write(
    `\nYou're at the main menu. Read it above, then drive with ` +
    `\`mvplay key <name>\` / \`mvplay say "<text>"\` and \`mvplay wait\`.\n`,
  );
}

/** Print the rendered screen. */
export async function screen(ansi = false): Promise<void> {
  const s = requireSession();
  const out = await getScreen(s, ansi);
  process.stdout.write(out.replace(/\n+$/, "") + "\n");
}

/** Print a compact state summary. */
export async function state(): Promise<void> {
  const s = requireSession();
  const snap = await getState(s);
  process.stdout.write(summarizeState(snap, s.readCursor) + "\n");
}

/**
 * Print narrative lines. By default shows only what's new since the read
 * cursor and advances it; `--all` shows everything (also advancing).
 */
export async function narrative(opts: { all?: boolean } = {}): Promise<void> {
  const s = requireSession();
  const snap = await getState(s);
  const from = opts.all ? 0 : s.readCursor;
  const body = formatNarrative(snap.narrativeLines, from);
  process.stdout.write((body || "(no new narrative)") + "\n");
  if (snap.activeChoices) {
    process.stdout.write("\nchoices:\n" + formatChoices(snap.activeChoices) + "\n");
  }
  s.readCursor = snap.narrativeLines.length;
  writeSession(s);
}

/**
 * Submit free text (a player action / answer) and Enter. If a choice overlay
 * is currently up, navigate to the "Enter your own" custom-input row first so
 * the text lands in the right place. Records the current overlay fingerprint
 * so a subsequent `wait` won't mistake a lingering stale overlay for a new
 * beat.
 */
export async function say(text: string): Promise<void> {
  const s = requireSession();
  const snap = await getState(s);
  const baseline = snap.narrativeLines.length;
  const hadChoices = !!snap.activeChoices;
  if (snap.activeChoices) s.lastChoiceFp = choiceFp(snap.activeChoices);

  const submit = async () => {
    if (hadChoices) {
      // The overlay's index 0 is "Enter your own ..."; UP forces selection
      // there with the custom input active regardless of list length.
      await postKey(s, "up");
      await sleep(60);
    }
    await postText(s, text);
    await sleep(60);
    await postKey(s, "return");
  };

  await submit();
  let ok = await inputAccepted(s, baseline, 4000);
  if (!ok) {
    // Raced with a still-finalizing turn; clear any partial buffer and resend.
    await postKey(s, "ctrl+u");
    await sleep(80);
    await submit();
    ok = await inputAccepted(s, baseline, 4000);
  }
  writeSession(s);

  if (ok) {
    process.stdout.write(`✔ submitted: ${JSON.stringify(text)}\n`);
  } else {
    process.stdout.write(
      `⚠ submitted ${JSON.stringify(text)} but saw no acknowledgement. ` +
      `Check \`mvplay state\`; the game may not have accepted it.\n`,
    );
    process.exitCode = 1;
  }
}

/** Send a single named key (return, up, down, escape, tab, ...). */
export async function key(name: string): Promise<void> {
  const s = requireSession();
  await postKey(s, name);
  process.stdout.write(`✔ key: ${name}\n`);
}

/**
 * Select a choice from the current overlay. `query` is either a 1-based
 * position ("2") or a case-insensitive label substring. Uses the robust
 * normalization dance (UP to the custom row, then DOWN past it to the first
 * real choice, then DOWN to the target) so it works regardless of the
 * overlay's initial selection or whether the short-list custom input was
 * auto-focused.
 */
export async function pick(query: string): Promise<void> {
  const s = requireSession();
  const snap = await getState(s);
  if (!snap.activeChoices) {
    throw new Error("No choice overlay is currently presented. Use `mvplay state` to check.");
  }
  const labels = snap.activeChoices.choices.map(choiceLabel);

  let index: number;
  const asNum = Number(query);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= labels.length) {
    index = asNum - 1;
  } else {
    const lower = query.toLowerCase();
    index = labels.findIndex((l) => l.toLowerCase().includes(lower));
    if (index < 0) {
      throw new Error(
        `No choice matches ${JSON.stringify(query)}. Available:\n${formatChoices(snap.activeChoices)}`,
      );
    }
  }

  s.lastChoiceFp = choiceFp(snap.activeChoices);
  const baseline = snap.narrativeLines.length;

  // Normalize: UP → custom row (UI idx 0, customInput active); DOWN → first
  // real choice (server idx 0); DOWN*index → target server idx; Return.
  const submit = async () => {
    await postKey(s, "up");
    await sleep(50);
    await postKey(s, "down");
    for (let i = 0; i < index; i++) {
      await sleep(50);
      await postKey(s, "down");
    }
    await sleep(50);
    await postKey(s, "return");
  };

  await submit();
  let ok = await inputAccepted(s, baseline, 4000);
  if (!ok) {
    await submit();
    ok = await inputAccepted(s, baseline, 4000);
  }
  writeSession(s);

  if (ok) {
    process.stdout.write(`✔ picked #${index + 1}: ${JSON.stringify(labels[index])}\n`);
  } else {
    process.stdout.write(
      `⚠ tried to pick #${index + 1} (${JSON.stringify(labels[index])}) but saw no ` +
      `acknowledgement. Check \`mvplay state\`.\n`,
    );
    process.exitCode = 1;
  }
}

export type WaitFor = "beat" | "handoff" | "choices";

export interface WaitOptions {
  /** What to settle on. "beat" (default) catches any new turn/choice/handoff. */
  for?: WaitFor;
  /** Seconds before giving up. Default 360 (6 min) — covers the first DM turn. */
  timeoutSec?: number;
}

/**
 * Block until the game produces a new beat the agent should react to, then
 * print what's new (narrative delta + any choices) and exit. Designed to be
 * run with `run_in_background`: the agent is re-invoked when this process
 * exits.
 *
 * "Settled" = any of: new agent narrative while waiting for input; a new
 * choice overlay; a turn opening that wasn't open before; or a setup→live
 * handoff. The read cursor / fingerprints from the session file distinguish
 * genuinely-new beats from stale overlays the engine left on screen.
 *
 * Exits 0 on settle, 1 on timeout (printing the current state + log tail so
 * the agent can diagnose without re-running).
 */
export async function wait(opts: WaitOptions = {}): Promise<void> {
  const s = requireSession();
  const forWhat = opts.for ?? "beat";
  // Guard against NaN/Infinity/<=0 sneaking in from CLI parsing — any of those
  // would make the deadline NaN and trip an immediate bogus timeout.
  const timeoutSec =
    typeof opts.timeoutSec === "number" && Number.isFinite(opts.timeoutSec) && opts.timeoutSec > 0
      ? opts.timeoutSec
      : 360;
  const deadline = Date.now() + timeoutSec * 1000;

  const baselineCursor = s.readCursor;
  const baselineChoiceFp = s.lastChoiceFp;
  const baselineSeq = s.lastTurnSeq;
  const baselineCampaign = s.lastCampaignId;

  let settledSnap: ClientStateSnapshot | null = null;
  while (Date.now() < deadline) {
    if (!isAlive(s.pid)) {
      process.stdout.write(
        `✘ session process (pid ${s.pid}) is no longer running. Log tail:\n` +
        tailFile(s.launcherLog, 30) + "\n",
      );
      process.exitCode = 1;
      return;
    }
    let snap: ClientStateSnapshot;
    try {
      snap = await getState(s);
    } catch {
      await sleep(700);
      continue;
    }

    const delta = snap.narrativeLines.slice(baselineCursor);
    const narrativeAdvanced =
      snap.engineState === "waiting_input" &&
      delta.length > 0 &&
      delta.some((l) => l.kind !== "player");
    const fp = snap.activeChoices ? choiceFp(snap.activeChoices) : null;
    const choicesAdvanced = fp !== null && fp !== baselineChoiceFp;
    const turnOpened =
      snap.currentTurn?.status === "open" &&
      (snap.currentTurn.seq !== baselineSeq ||
        (snap.currentTurn.campaignId ?? null) !== baselineCampaign);
    const handoff = snap.transitionCampaignId !== null;

    const settled =
      forWhat === "handoff"
        ? handoff || (snap.currentTurn?.campaignId != null && snap.currentTurn.campaignId !== "__setup__")
        : forWhat === "choices"
          ? choicesAdvanced
          : narrativeAdvanced || choicesAdvanced || turnOpened || handoff;

    if (settled) { settledSnap = snap; break; }
    await sleep(700);
  }

  if (!settledSnap) {
    let snap: ClientStateSnapshot | null = null;
    try { snap = await getState(s); } catch { /* ignore */ }
    process.stdout.write(`⏳ timed out after ${timeoutSec}s waiting for a new beat.\n`);
    if (snap) process.stdout.write(summarizeState(snap, baselineCursor) + "\n");
    process.stdout.write("\nlauncher log tail:\n" + tailFile(s.launcherLog, 20) + "\n");
    process.exitCode = 1;
    return;
  }

  // Show the delta and advance the cursor / fingerprints.
  const body = formatNarrative(settledSnap.narrativeLines, baselineCursor);
  if (body) process.stdout.write(body + "\n");
  if (settledSnap.activeChoices) {
    process.stdout.write("\nchoices:\n" + formatChoices(settledSnap.activeChoices) + "\n");
  }
  if (settledSnap.transitionCampaignId) {
    process.stdout.write(
      `\n→ handoff to live campaign: ${settledSnap.transitionCampaignName ?? settledSnap.transitionCampaignId}\n`,
    );
  }
  process.stdout.write(
    `\n[${settledSnap.engineState ?? "?"}] ${settledSnap.narrativeLines.length} narrative lines total.\n`,
  );

  s.readCursor = settledSnap.narrativeLines.length;
  s.lastChoiceFp = settledSnap.activeChoices ? choiceFp(settledSnap.activeChoices) : s.lastChoiceFp;
  s.lastTurnSeq = settledSnap.currentTurn?.seq ?? s.lastTurnSeq;
  s.lastCampaignId = settledSnap.currentTurn?.campaignId ?? s.lastCampaignId;
  writeSession(s);
}

/** Tail the detached launcher's log file (crash diagnostics). */
export async function log(tailLines = 40): Promise<void> {
  const s = readSession();
  const path = s?.launcherLog ?? LAUNCHER_LOG;
  if (!existsSync(path)) {
    process.stdout.write("(no launcher log yet)\n");
    return;
  }
  process.stdout.write(tailFile(path, tailLines) + "\n");
}

/** Report whether a session is alive and its vitals. */
export async function status(): Promise<void> {
  const s = readSession();
  if (!s) { process.stdout.write("no session\n"); return; }
  const alive = isAlive(s.pid);
  process.stdout.write(
    `session: pid ${s.pid} (${alive ? "alive" : "DEAD"}), sidecar :${s.agentPort}, ` +
    `player ${JSON.stringify(s.player)}, seen ${s.readCursor} narrative lines` +
    (s.recording ? `, ● recording "${s.recording}"` : "") + "\n",
  );
  if (alive) {
    try {
      const snap = await getState(s);
      process.stdout.write(summarizeState(snap, s.readCursor) + "\n");
    } catch (err) {
      process.stdout.write(`(sidecar unreachable: ${String(err)})\n`);
    }
  }
}

/**
 * Pull the session tape recorded so far (via the engine's dev-only `GET /tape`)
 * and write it to `outPath` as a golden `{ scenario, tape, expectedNarrative }`,
 * where `expectedNarrative` is the DM/non-player narrative captured this session
 * — the deterministic replay target. The session must have been started with
 * `mvplay record <scenario>`; pull the tape BEFORE `mvplay stop`, since teardown
 * force-kills the engine and its in-memory tape with it.
 */
export async function saveTape(outPath: string): Promise<void> {
  const s = requireSession();
  if (!s.recording) {
    throw new Error(
      "This session is not recording. Start it with `mvplay record <scenario>` to capture a tape.",
    );
  }
  let tape: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${s.serverPort}/tape`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET /tape returned ${res.status} ${body}`);
    }
    tape = await res.json();
  } catch (err) {
    throw new Error(
      `Could not pull the tape from the engine on port ${s.serverPort}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Capture the narrative produced this session as the replay assertion target.
  let expectedNarrative: string[] = [];
  try {
    const snap = await getState(s);
    expectedNarrative = snap.narrativeLines
      .filter((l) => l.kind !== "player")
      .map((l) => l.text);
  } catch { /* tape alone is still useful */ }

  const golden = { scenario: s.recording, tape, expectedNarrative };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(golden, null, 2) + "\n");
  process.stdout.write(
    `✔ saved golden "${s.recording}" → ${outPath}\n` +
    `  (${expectedNarrative.length} narrative lines captured; review the diff before committing)\n`,
  );
}

/** Kill the session process tree and remove the session file. */
export async function stop(): Promise<void> {
  const s = readSession();
  if (!s) { process.stdout.write("no session to stop\n"); return; }
  if (isAlive(s.pid)) killTree(s.pid);
  try { rmSync(SESSION_FILE); } catch { /* ignore */ }
  process.stdout.write(`✔ stopped session (pid ${s.pid})\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tailFile(path: string, n: number): string {
  if (!existsSync(path)) return "(no log)";
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-n).map((l) => "    " + l).join("\n");
  } catch {
    return "(log unreadable)";
  }
}
