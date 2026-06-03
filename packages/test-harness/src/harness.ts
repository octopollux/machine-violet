/**
 * The test harness: spawn the launcher with a sidecar attached, drive the
 * TUI through HTTP, observe state transitions.
 *
 * Lifecycle:
 *
 *   const h = await Harness.launch({ campaignsDir, ... });
 *   try {
 *     await h.waitForMenu();
 *     await h.sendKey("return");          // pick "New Campaign"
 *     ...
 *   } finally {
 *     await h.shutdown();
 *   }
 *
 * The harness owns one child process. It always cleans up: shutdown() kills
 * the process tree and removes any temporary campaigns dir if `cleanup` was
 * requested. Long probes should put shutdown() in a `finally` block.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pollUntil,
  type WaitOptions,
  DEFAULT_SHORT_TIMEOUT_MS,
  DEFAULT_LONG_TIMEOUT_MS,
} from "./wait.js";
import {
  buildLaunchEnv,
  pickEphemeralPort,
  LAUNCHER_NODE_ARGS,
} from "./launch-env.js";
import type { ClientStateSnapshot, ActiveChoices } from "./client-state.js";
import { choiceLabel } from "./client-state.js";
import {
  readEngineLog,
  waitForEngineEvent,
  formatEngineEvent,
  type EngineLogEvent,
} from "./engine-log.js";

export interface HarnessOptions {
  /** Port for the engine REST + WS server. Default: ephemeral high port. */
  serverPort?: number;
  /** Port for the agent sidecar HTTP server. Default: ephemeral high port. */
  agentPort?: number;
  /** Campaign data directory. Default: a fresh tmp dir wiped on shutdown. */
  campaignsDir?: string;
  /** Player name passed to the launcher. */
  player?: string;
  /** Pass-through campaign id (skips menu, auto-starts). Usually omitted. */
  campaign?: string;
  /**
   * Working directory for the spawned launcher. In dev mode, configDir() ==
   * process.cwd(), so this also determines where the engine looks for
   * `connections.json` and `.env`. If omitted, the harness walks up from
   * REPO_ROOT looking for the first ancestor that contains `connections.json`
   * — this lets a worktree run the live golden path without copying
   * credentials in.
   */
  cwd?: string;
  /**
   * Where to send child stdio.
   *   "inherit"  — pipe to current process (useful when interactively debugging)
   *   "buffer"   — captured in memory, exposed via Harness.childLog (default)
   *   "ignore"   — drop everything
   */
  stdio?: "inherit" | "buffer" | "ignore";
  /** Extra env vars to set on the child process. */
  env?: Record<string, string>;
  /** Max time to wait for the sidecar to become reachable. Default 30s. */
  launchTimeoutMs?: number;
}

export interface ShutdownOptions {
  /** Remove the temporary campaigns dir if the harness created one. Default true. */
  cleanup?: boolean;
}

export class Harness {
  /** Captured combined stdout/stderr from the child when stdio: "buffer". */
  readonly childLog: string[] = [];

  /**
   * Engine log start cutoff (ms since epoch). All readEngineLog /
   * waitForEngineEvent reads filter to events with `t >= launchedAt`
   * so stale entries from prior runs don't leak in.
   *
   * Why this matters: the engine log lives at
   * `dirname(campaignsDir)/.debug/engine.jsonl`. With the harness's
   * default ephemeral campaignsDir under `os.tmpdir()`, that resolves
   * to a SHARED `tmpdir/.debug/engine.jsonl` across every harness run.
   * Without the cutoff, a probe could "pass" by finding an
   * image_gen:completed event left over from yesterday's run.
   */
  readonly launchedAt: number;

  private constructor(
    private readonly child: ChildProcess,
    readonly serverPort: number,
    readonly agentPort: number,
    readonly campaignsDir: string,
    readonly ownsCampaignsDir: boolean,
    launchedAt: number,
  ) {
    this.launchedAt = launchedAt;
  }

  // -------------------------------------------------------------------------
  // Launch + shutdown
  // -------------------------------------------------------------------------

  static async launch(opts: HarnessOptions = {}): Promise<Harness> {
    // Capture the cutoff BEFORE we spawn so engine events emitted by the
    // child are guaranteed to have `t >= launchedAt`. (Capturing later
    // would race with the engine's startup events.)
    const launchedAt = Date.now();
    const serverPort = opts.serverPort ?? pickEphemeralPort();
    const agentPort = opts.agentPort ?? pickEphemeralPort();
    const launchTimeoutMs = opts.launchTimeoutMs ?? 30_000;
    const stdio = opts.stdio ?? "buffer";

    let campaignsDir: string;
    let ownsCampaignsDir = false;
    if (opts.campaignsDir) {
      campaignsDir = opts.campaignsDir;
    } else {
      campaignsDir = await mkdtemp(join(tmpdir(), "mv-e2e-"));
      ownsCampaignsDir = true;
    }

    // buildLaunchEnv handles the env assembly, the worktree-credential
    // walk-up (configDir() == process.cwd() in dev), and the empty-env-var
    // dotenv workaround for embedded shells. See launch-env.ts.
    const { env, cwd } = buildLaunchEnv({
      serverPort,
      agentPort,
      campaignsDir,
      player: opts.player,
      campaign: opts.campaign,
      cwd: opts.cwd,
      extraEnv: opts.env,
    });
    const args = [...LAUNCHER_NODE_ARGS];

    const childLog: string[] = [];
    const child = spawn(process.execPath, args, {
      env,
      cwd,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      // Windows: detached:false keeps signals working; the harness explicitly
      // kills the whole tree on shutdown via taskkill / SIGTERM.
    });

    if (stdio === "buffer") {
      const onData = (buf: Buffer) => {
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (const line of lines) {
          if (line.length > 0) childLog.push(line);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    } else if (stdio === "ignore") {
      child.stdout?.resume();
      child.stderr?.resume();
    }

    // Wait for the sidecar to be reachable. If the child dies first, throw.
    const start = Date.now();
    let lastErr: unknown;
    const childDied = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        const tail = childLog.slice(-30).join("\n");
        reject(new Error(
          `Launcher exited before sidecar became ready ` +
          `(code=${code}, signal=${signal}). Recent output:\n${tail}`,
        ));
      });
    });
    const sidecarReady = (async () => {
      while (Date.now() - start < launchTimeoutMs) {
        try {
          const r = await fetch(`http://127.0.0.1:${agentPort}/state`);
          if (r.ok) return;
        } catch (err) {
          lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `Sidecar did not become reachable on port ${agentPort} within ` +
        `${launchTimeoutMs}ms. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    })();

    try {
      await Promise.race([sidecarReady, childDied]);
    } catch (err) {
      await terminateChild(child).catch(() => { /* best-effort */ });
      if (ownsCampaignsDir) {
        await rm(campaignsDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
      throw err;
    }

    const harness = new Harness(child, serverPort, agentPort, campaignsDir, ownsCampaignsDir, launchedAt);
    // Pipe captured log into the harness instance.
    if (stdio === "buffer") {
      for (const line of childLog) harness.childLog.push(line);
      const onData = (buf: Buffer) => {
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (const line of lines) {
          if (line.length > 0) harness.childLog.push(line);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    }
    return harness;
  }

  async shutdown(opts: ShutdownOptions = {}): Promise<void> {
    await terminateChild(this.child).catch(() => { /* best-effort */ });
    if (this.ownsCampaignsDir && opts.cleanup !== false) {
      await rm(this.campaignsDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  }

  // -------------------------------------------------------------------------
  // Reading state + screen
  // -------------------------------------------------------------------------

  /** Fetch the current ClientState snapshot from /state. */
  async getState(): Promise<ClientStateSnapshot> {
    const res = await fetch(`http://127.0.0.1:${this.agentPort}/state`);
    if (!res.ok) throw new Error(`/state returned ${res.status}`);
    return await res.json() as ClientStateSnapshot;
  }

  /** Fetch the current rendered screen (plain text). */
  async getScreen(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${this.agentPort}/screen`);
    if (!res.ok) throw new Error(`/screen returned ${res.status}`);
    return await res.text();
  }

  /** Fetch the rendered screen with ANSI escape sequences preserved. */
  async getScreenAnsi(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${this.agentPort}/screen?ansi=true`);
    if (!res.ok) throw new Error(`/screen?ansi returned ${res.status}`);
    return await res.text();
  }

  // -------------------------------------------------------------------------
  // Sending input
  // -------------------------------------------------------------------------

  /** POST a named key to /input/key. See KEY_MAP in agent-sidecar.ts. */
  async sendKey(key: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.agentPort}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new Error(`sendKey(${key}) failed: ${res.status} ${body}`);
    }
  }

  /** Send the same key N times with a small delay so Ink renders between presses. */
  async sendKeys(key: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.sendKey(key);
      if (i < count - 1) await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** POST raw text (typed characters) to /input. */
  async sendText(text: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.agentPort}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: text,
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new Error(`sendText failed: ${res.status} ${body}`);
    }
  }

  /** Send text + Enter, with a small delay so the text settles before submit. */
  async submitText(text: string): Promise<void> {
    await this.sendText(text);
    await new Promise((r) => setTimeout(r, 50));
    await this.sendKey("return");
  }

  // -------------------------------------------------------------------------
  // Choice navigation: find the right entry, arrow over to it, press enter.
  // -------------------------------------------------------------------------

  /**
   * Pick a choice from the current `activeChoices` overlay. Searches by
   * exact label match first, then case-insensitive substring. Throws if
   * no choice is currently presented or no candidate matches.
   *
   * Implementation: assumes the overlay opens with selection at index 0.
   * If your probe navigates choices between presentations, drive arrow
   * keys directly with sendKey.
   */
  async selectChoice(query: string | { index: number }): Promise<void> {
    const state = await this.getState();
    const choices = state.activeChoices;
    if (!choices) throw new Error(`selectChoice: no activeChoices presented`);

    let targetIndex: number;
    if (typeof query === "object") {
      targetIndex = query.index;
    } else {
      targetIndex = findChoiceIndex(choices, query);
      if (targetIndex < 0) {
        const labels = choices.choices.map(choiceLabel);
        throw new Error(`selectChoice(${JSON.stringify(query)}): no match. Available: ${JSON.stringify(labels)}`);
      }
    }
    if (targetIndex < 0 || targetIndex >= choices.choices.length) {
      throw new Error(`selectChoice: index ${targetIndex} out of range (${choices.choices.length} choices)`);
    }
    // The ChoiceOverlay opens with selection at index 0; navigate down.
    if (targetIndex > 0) {
      await this.sendKeys("down", targetIndex);
    }
    await this.sendKey("return");
  }

  // -------------------------------------------------------------------------
  // State-driven waits
  // -------------------------------------------------------------------------

  /**
   * Wait until the predicate is satisfied. Polls /state at pollMs intervals.
   * Returns the first satisfying snapshot.
   */
  async waitForState(
    predicate: (s: ClientStateSnapshot) => boolean,
    opts: WaitOptions,
  ): Promise<ClientStateSnapshot> {
    return pollUntil(() => this.getState(), predicate, opts);
  }

  /** Wait until engineState matches one of the named values. */
  async waitForEngineState(
    states: string | string[],
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<ClientStateSnapshot> {
    const wanted = Array.isArray(states) ? states : [states];
    return this.waitForState(
      (s) => s.engineState !== null && wanted.includes(s.engineState),
      { description: `engineState in {${wanted.join(",")}}`, ...opts },
    );
  }

  /** Wait until `activeChoices` is non-null. */
  async waitForChoices(
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<ClientStateSnapshot> {
    return this.waitForState(
      (s) => s.activeChoices !== null,
      { description: "activeChoices presented", timeoutMs: DEFAULT_LONG_TIMEOUT_MS, ...opts },
    );
  }

  /** Wait until `activeChoices` is cleared (server accepted the selection). */
  async waitForChoicesCleared(
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<ClientStateSnapshot> {
    return this.waitForState(
      (s) => s.activeChoices === null,
      { description: "activeChoices cleared", ...opts },
    );
  }

  /** Wait until narrativeLines grows past the baseline length. */
  async waitForNarrativeAtLeast(
    minLength: number,
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<ClientStateSnapshot> {
    return this.waitForState(
      (s) => s.narrativeLines.length >= minLength,
      { description: `narrativeLines.length >= ${minLength}`, timeoutMs: DEFAULT_LONG_TIMEOUT_MS, ...opts },
    );
  }

  /** Wait until `mode` flips to the given value. */
  async waitForMode(
    mode: ClientStateSnapshot["mode"],
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<ClientStateSnapshot> {
    return this.waitForState(
      (s) => s.mode === mode,
      { description: `mode === ${mode}`, ...opts },
    );
  }

  /**
   * Wait until the screen contains the given substring. Polls /screen at
   * pollMs intervals. Use sparingly — state-driven waits are more reliable.
   * Mostly useful for menu-phase navigation where the menu items aren't
   * exposed in ClientState.
   */
  async waitForScreen(
    needle: string,
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<string> {
    return pollUntil(
      () => this.getScreen(),
      (screen) => screen.includes(needle),
      { description: `screen contains ${JSON.stringify(needle)}`, ...opts },
    );
  }

  // -------------------------------------------------------------------------
  // Session lifecycle (server REST — bypasses TUI navigation)
  // -------------------------------------------------------------------------

  /**
   * End the active session via `POST /session/end`. The server flushes the
   * scene to disk, creates a git checkpoint, generates the session recap,
   * and broadcasts `session:ended`. Equivalent to selecting "Save & Exit"
   * in the in-game menu, minus the keystroke navigation. Use this when
   * your probe isn't specifically testing menu nav.
   */
  async endSession(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.serverPort}/session/end`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`endSession failed: ${res.status} ${body}`);
    }
  }

  // -------------------------------------------------------------------------
  // Engine log + filesystem inspection
  // -------------------------------------------------------------------------

  /**
   * Read structured events the engine has written to `.debug/engine.jsonl`
   * since this harness instance was launched. Events from prior harness
   * runs (the log file is shared across all runs that share a campaigns
   * parent, including all e2e runs under `os.tmpdir()`) are filtered out
   * via the {@link launchedAt} cutoff. Returns [] if the engine hasn't
   * written anything yet.
   *
   * Use this when you need a punctual snapshot. For "wait until event X
   * appears" use {@link waitForEngineEvent}.
   */
  readEngineLog(): EngineLogEvent[] {
    return readEngineLog(this.campaignsDir).filter((e) => e.t >= this.launchedAt);
  }

  /**
   * Wait until the engine log contains at least one event matching `match`
   * AND emitted after this harness instance launched. `match` is either an
   * event name (`"image_gen:completed"`) or a predicate. Resolves with the
   * first matching event.
   *
   * Probes that drive a slow async path (image generation, DM turn) should
   * use this instead of poking at ClientState — the engine log carries
   * intent + payload, not just "narrative grew."
   */
  async waitForEngineEvent(
    match: string | ((e: EngineLogEvent) => boolean),
    opts: Omit<WaitOptions, "description"> & { description?: string } = {},
  ): Promise<EngineLogEvent> {
    const namePredicate = typeof match === "function" ? match : (e: EngineLogEvent) => e.event === match;
    const scopedPredicate = (e: EngineLogEvent) => e.t >= this.launchedAt && namePredicate(e);
    return waitForEngineEvent(this.campaignsDir, scopedPredicate, opts);
  }

  /**
   * Resolve the absolute path of a campaign on disk. `__setup__` is the
   * synthetic scratch campaign used during new-campaign setup.
   */
  campaignPath(campaignId: string): string {
    return join(this.campaignsDir, campaignId);
  }

  /**
   * List files inside a campaign subdirectory (e.g. `"campaign/images"`,
   * `"characters"`). Returns absolute paths, sorted. Returns [] if the
   * directory doesn't exist.
   *
   * Useful for asserting "the image actually landed on disk" after a
   * portrait-loop turn completes.
   */
  listCampaignFiles(campaignId: string, subdir: string): string[] {
    const root = join(this.campaignPath(campaignId), ...subdir.split(/[\\/]/));
    if (!existsSync(root)) return [];
    try {
      return readdirSync(root)
        .filter((name) => {
          try {
            return statSync(join(root, name)).isFile();
          } catch {
            return false;
          }
        })
        .sort()
        .map((name) => join(root, name));
    } catch {
      return [];
    }
  }

  /**
   * Pretty-print the engine log tail. Useful in failure paths so the
   * probe runner dumps something diagnostic alongside /screen + /state.
   */
  engineLogTail(n = 50): string {
    return this.readEngineLog().slice(-n).map(formatEngineEvent).join("\n");
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  /** Format the last N lines of captured child output. */
  childLogTail(n = 30): string {
    return this.childLog.slice(-n).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChoiceIndex(choices: ActiveChoices, query: string): number {
  const labels = choices.choices.map(choiceLabel);
  const exact = labels.indexOf(query);
  if (exact >= 0) return exact;
  const lower = query.toLowerCase();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].toLowerCase().includes(lower)) return i;
  }
  return -1;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Windows: kill the whole tree, otherwise the engine subprocess stays alive.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else {
    // Track actual exit via the 'exit' event. `child.killed` flips to true
    // the moment a signal is sent, NOT when the process exits — guarding
    // the SIGKILL fallback on `!child.killed` would never fire against a
    // child that ignores SIGTERM.
    let exited = false;
    child.once("exit", () => { exited = true; });
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!exited && child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

// Convenient default-timeout constants for probes.
export { DEFAULT_SHORT_TIMEOUT_MS, DEFAULT_LONG_TIMEOUT_MS };
