/**
 * Shared launch preparation for everything that spawns the MachineViolet
 * launcher with an agent sidecar attached.
 *
 * Two consumers:
 *   - {@link Harness} (the one-shot probe runner) — spawns, drives a scripted
 *     body, then hard-kills the process.
 *   - the persistent {@link ./session-driver.js} (interactive play) — spawns a
 *     *detached* process that outlives the launching command, so a coding
 *     agent can drive the game turn-for-turn across many tool calls.
 *
 * Both need the exact same env/cwd/API-key handling, so it lives here once.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (works from src or dist). */
export const REPO_ROOT = resolve(__dirname, "../../..");

/** The launcher entry point the SEA binary and `npm run dev` both use. */
export const LAUNCHER_PATH = join(REPO_ROOT, "scripts", "launcher.ts");

/**
 * Node args to run the launcher under tsx. `--max-semi-space-size=16` keeps
 * the young-generation GC pauses short in the long-lived client process.
 */
export const LAUNCHER_NODE_ARGS: readonly string[] = [
  "--max-semi-space-size=16",
  "--import",
  "tsx/esm",
  LAUNCHER_PATH,
];

/**
 * Pick a port in the 30000-39999 range. Callers re-check reachability after
 * spawn (via the sidecar-ready probe), so a collision just looks like a
 * launch timeout rather than a silent wrong-process attach.
 */
export function pickEphemeralPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

export interface LaunchEnvOptions {
  serverPort: number;
  agentPort: number;
  campaignsDir: string;
  /** Player name passed to the launcher. Default "TestPlayer". */
  player?: string;
  /** Auto-start a campaign id (skips the menu). Usually omitted. */
  campaign?: string;
  /**
   * Working directory for the spawned launcher. In dev mode configDir() ==
   * process.cwd(), so this also determines where the engine reads
   * `connections.json` and `.env`. If omitted, walks up from REPO_ROOT to
   * the first ancestor that has a `connections.json`.
   */
  cwd?: string;
  /** Extra env vars to set on the child. */
  extraEnv?: Record<string, string>;
}

/**
 * Assemble the `{ env, cwd }` for spawning the launcher. Mirrors what real
 * users get from `npm run dev`, plus the worktree-credential walk-up and the
 * empty-env-var dotenv workaround (see {@link injectApiKeysFromEnvFile}).
 */
export function buildLaunchEnv(opts: LaunchEnvOptions): {
  env: NodeJS.ProcessEnv;
  cwd: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MV_PORT: String(opts.serverPort),
    MV_AGENT_PORT: String(opts.agentPort),
    MV_CAMPAIGNS: opts.campaignsDir,
    MV_PLAYER: opts.player ?? "TestPlayer",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    ...opts.extraEnv,
  };
  if (opts.campaign) env.MV_CAMPAIGN = opts.campaign;

  const cwd = opts.cwd ?? findConfigDir(REPO_ROOT);
  injectApiKeysFromEnvFile(env, join(cwd, ".env"));
  return { env, cwd };
}

/**
 * Pull `*_API_KEY` and `*_BASE_URL` values out of the .env file and stuff
 * them into `env` if the corresponding key is missing or empty. We don't
 * use dotenv because dotenv refuses to overwrite already-present empty
 * keys without `override: true`, and we don't want to modify the engine's
 * loadEnv() to set override:true globally — that'd surprise normal users
 * whose .env values should *not* clobber explicitly-set process env vars.
 *
 * Background: embedded shells (Claude Code, some CI runners) pre-set
 * sensitive env vars like ANTHROPIC_API_KEY="" as an empty string to
 * sandbox subprocesses. The engine uses dotenv without override:true, so an
 * empty value blocks .env from populating the real key. Here we treat empty
 * as "unset" and explicitly load any *_API_KEY from the configDir's .env so
 * a probe (or interactive session) can run from inside such shells.
 */
export function injectApiKeysFromEnvFile(env: NodeJS.ProcessEnv, envPath: string): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes per common .env conventions.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only inject API keys and base URLs — those are what the engine cares
    // about for provider connections. Don't dump arbitrary .env contents
    // into the spawn env.
    if (!/^[A-Z0-9_]+_(API_KEY|BASE_URL)$/.test(key)) continue;
    if (!env[key]) env[key] = value;
  }
}

/**
 * Walk up from `start` looking for the first directory that contains a
 * `connections.json`. Falls back to `start` if none is found in 12 levels.
 *
 * Background: in dev mode, the engine's `configDir()` returns `process.cwd()`
 * — so when a worktree spawns the launcher with cwd=worktree, the launcher
 * reads connections from the worktree (which is empty), then refuses to
 * start a campaign. Walking up lets a worktree pick up the main repo's
 * existing credentials without copies.
 */
export function findConfigDir(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "connections.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
