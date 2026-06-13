#!/usr/bin/env node
/**
 * Install lefthook git hooks (run from the root `prepare` script on every
 * `npm install` / `npm ci`).
 *
 * Why this exists instead of a bare `lefthook install`:
 *
 * lefthook 2.0 hard-fails `install` when `core.hooksPath` points at a custom
 * directory — a deliberate safety check so it won't clobber hooks it didn't
 * create. This repo *does* set `core.hooksPath` (to the main checkout's own
 * `.git/hooks`) so every git worktree shares one hooks dir, which is the setup
 * our worktree-based workflow depends on. So a bare install breaks `npm install`
 * repo-wide.
 *
 * The blunt fix — always `lefthook install --force` — disables that safety
 * check for *everyone*: a developer who has a personal global hooksPath
 * (`git config --global core.hooksPath ~/.githooks`) would have it silently
 * overwritten on every `npm install` (see PR #636 review). That's a real
 * footgun on a script that runs unattended.
 *
 * So we only pass `--force` when `core.hooksPath` resolves to THIS repo's own
 * common hooks dir (the worktree-shared case, where forcing is safe because the
 * target is our own `.git/hooks`). In every other case — no hooksPath set (the
 * common clone), or a hooksPath pointing somewhere external — we fall back to a
 * plain `lefthook install`, preserving lefthook's default safety behavior.
 */
import { execSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

/** Run a git command, returning trimmed stdout; throws on failure. */
function git(args) {
  return execSync(`git ${args}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

let force = false;
try {
  // Throws when core.hooksPath is unset — the common case, leaves force=false.
  const hooksPath = git("config --get core.hooksPath");
  if (hooksPath) {
    // The shared hooks dir for a repo (and all its worktrees) is
    // <git-common-dir>/hooks. Forcing is safe iff hooksPath IS that dir.
    const commonHooks = resolve(git("rev-parse --git-common-dir"), "hooks");
    force = resolve(hooksPath) === commonHooks;
  }
} catch {
  // No core.hooksPath configured → plain install into .git/hooks.
}

// Resolve the lefthook binary from node_modules/.bin regardless of whether we
// were invoked inside the npm lifecycle (which adds .bin to PATH) or directly.
const binDir = join(import.meta.dirname, "..", "node_modules", ".bin");
const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };

execSync(`lefthook install${force ? " --force" : ""}`, { stdio: "inherit", env });
