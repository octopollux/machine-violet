/**
 * Structured engine event log.
 *
 * Append-only JSONL file at `.debug/engine.jsonl`. Captures server lifecycle,
 * session lifecycle, turn lifecycle, API calls, subagent lifecycle, and errors
 * in one place. Always on.
 *
 * Same module-level pattern as context-dump.ts: init once at server start,
 * reset on teardown.
 *
 * ## Why synchronous appends instead of a WriteStream
 *
 * The original implementation used `createWriteStream` for non-blocking
 * fire-and-forget appends. That was great until we tried to read the log
 * mid-session for diagnostics: WriteStream buffers up to ~16KB before
 * touching disk (highWaterMark), so a live session could have logged
 * dozens of events that hadn't flushed yet. Reading `engine.jsonl` from
 * outside the process would show 0 bytes even though plenty had happened.
 *
 * Each event is a short JSON line (~100-500 bytes), happens at most a few
 * times per second, and the cost of an `appendFileSync` is microseconds.
 * The minor event-loop blocking is the correct trade for diagnostic
 * visibility — debug logs that aren't visible aren't logs.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";

let logPath: string | null = null;

/**
 * Initialize the engine log. Called once at server creation.
 * @param campaignsDir — the campaigns root; log goes to `../.debug/engine.jsonl`
 */
export function initEngineLog(campaignsDir: string): void {
  if (logPath) return; // already initialized
  try {
    const debugDir = join(dirname(campaignsDir), ".debug");
    mkdirSync(debugDir, { recursive: true });
    const path = join(debugDir, "engine.jsonl");
    // Touch the file so reads from outside the process don't 404 before the
    // first event lands. appendFileSync would create it too, but this makes
    // the contract explicit.
    if (!existsSync(path)) closeSync(openSync(path, "a"));
    logPath = path;
  } catch { /* best-effort */ }
}

/**
 * Log a structured event. Synchronous append — every call hits disk before
 * returning, so a tail / external reader sees the line immediately. Never
 * throws.
 *
 * @param event — event type (e.g. "session:start", "api:error")
 * @param data — event-specific fields (merged into the log line)
 */
export function logEvent(event: string, data?: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    const line = JSON.stringify({ ...data, t: Date.now(), event });
    appendFileSync(logPath, line + "\n");
  } catch { /* never break the game */ }
}

/** Close the log. Called on server shutdown. No-op now that writes are sync. */
export async function closeEngineLog(): Promise<void> {
  logPath = null;
}

/** Reset state (for tests). */
export async function resetEngineLog(): Promise<void> {
  await closeEngineLog();
}
