/**
 * Per-session `CODEX_HOME` isolation — allocation + date-based cleanup.
 *
 * codex initializes a single SQLite "state runtime" (`state_*.sqlite` + WAL,
 * plus `goals_*`, `logs_*`, `memories_*`, `sessions/`) under its home dir
 * (`CODEX_HOME`, default `~/.codex`) at startup. Concurrent codex subprocesses
 * sharing ONE home contend on that DB and the loser exits `code=1` with
 * `(code: 1546) disk I/O error` — root-caused from `.debug/engine.jsonl` (a
 * 4-wide simultaneous spawn against one `~/.codex` killed all four; staggered
 * spawns never did) and reproduced/fixed live (`bin/codex-home-isolation.ts`:
 * 4/4 concurrent isolated homes pass). Giving each subprocess its OWN home
 * removes the contention entirely; auth still works because MV pushes ChatGPT
 * tokens over RPC, not from `<home>/auth.json`.
 *
 * Lifecycle: the provider `mkdir`s its allocated home before spawn and `rm`s it
 * on `dispose()`, so in normal operation nothing accumulates. This module's
 * date-sweep is the BACKSTOP for homes leaked by a crash/kill that skipped
 * dispose — without it a machine that crashes often would slowly fill its temp
 * dir with thousands of dead homes.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, stat, rm } from "node:fs/promises";

/** Base dir under the OS temp holding all MV-managed per-session codex homes. */
export function codexHomeBase(): string {
  return join(tmpdir(), "machine-violet", "codex-homes");
}

/**
 * Allocate a unique (not-yet-created) per-session `CODEX_HOME` path. The caller
 * (provider) creates it before spawn and removes it on dispose. `hint` (e.g. a
 * connection id) is slugged into the dir name purely for traceability when
 * eyeballing leaked homes; uniqueness comes from the UUID, so collisions are
 * impossible even across processes.
 */
export function allocateCodexHome(hint?: string): string {
  const slug = (hint ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "codex";
  return join(codexHomeBase(), `${slug}-${randomUUID()}`);
}

/**
 * How stale a leftover home must be before the sweep reaps it. Homes are removed
 * on `dispose()` in the normal case, so this only ever catches crash-leaked
 * ones. Generous on purpose: an actually-active home has its `state_*.sqlite-wal`
 * rewritten every turn, so {@link sweepStaleCodexHomes} keys off the freshest
 * INSIDE-file mtime and a live session is never mistaken for stale — but a large
 * threshold is a second belt so even a pathologically long idle session survives.
 */
export const CODEX_HOME_STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let sweepStarted = false;
/**
 * Fire a one-time, best-effort date-sweep of the codex-home base for this
 * process (fire-and-forget so it never blocks provider creation). Idempotent —
 * safe to call on every provider construction; only the first call does work.
 * `nowMs` is injected (not read via `Date.now()` here) so callers control the
 * clock and the underlying sweep stays deterministically testable.
 */
export function sweepStaleCodexHomesOnce(nowMs: number, maxAgeMs = CODEX_HOME_STALE_MS): void {
  if (sweepStarted) return;
  sweepStarted = true;
  void sweepStaleCodexHomes(nowMs, maxAgeMs).catch(() => { /* best-effort backstop */ });
}

/** Test-only: reset the once-guard so a sweep can be re-triggered in a fresh test. */
export function resetCodexHomeSweepGuard(): void {
  sweepStarted = false;
}

/**
 * Remove every home under the base whose freshest internal file is older than
 * `maxAgeMs`. Keys off the newest mtime AMONG a home's immediate children (not
 * the dir's own mtime, which doesn't reliably update when files inside change),
 * so a home with a live session — whose SQLite WAL is rewritten every turn — is
 * never reaped out from under it. Best-effort: never throws; a dir that can't be
 * read or removed is skipped. Returns the count removed. Exported for tests.
 */
export async function sweepStaleCodexHomes(nowMs: number, maxAgeMs: number): Promise<number> {
  const base = codexHomeBase();
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0; // base not created yet — nothing to sweep
  }
  let removed = 0;
  for (const name of entries) {
    const dir = join(base, name);
    try {
      const freshest = await freshestMtimeMs(dir);
      if (freshest != null && nowMs - freshest > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Unreadable/racing dir — leave it; the next sweep can retry.
    }
  }
  return removed;
}

/**
 * Freshest mtime (ms) among a home dir and its immediate children, or null if
 * the path is gone/unreadable. A non-directory returns its own mtime. The
 * child scan is what makes an active home look fresh — its `*.sqlite-wal` is the
 * most-recently-written file each turn.
 */
async function freshestMtimeMs(dir: string): Promise<number | null> {
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return null;
  }
  if (!dirStat.isDirectory()) return dirStat.mtimeMs;
  let max = dirStat.mtimeMs;
  let children: string[];
  try {
    children = await readdir(dir);
  } catch {
    return max;
  }
  for (const name of children) {
    try {
      const st = await stat(join(dir, name));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch {
      // Vanished between readdir and stat — ignore.
    }
  }
  return max;
}
