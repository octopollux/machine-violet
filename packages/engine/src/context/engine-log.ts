/**
 * Structured engine event log.
 *
 * Append-only JSONL file at `.debug/engine.jsonl`. Captures server lifecycle,
 * session lifecycle, turn lifecycle, API calls, subagent lifecycle, and errors
 * in one place. Always on, non-blocking, fire-and-forget.
 *
 * Same module-level pattern as context-dump.ts: init once at server start,
 * reset on teardown. All writes go through a WriteStream so they never
 * block the event loop.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join, dirname } from "node:path";

let stream: WriteStream | null = null;

/**
 * Initialize the engine log. Called once at server creation.
 * @param campaignsDir — the campaigns root; log goes to `../.debug/engine.jsonl`
 */
export function initEngineLog(campaignsDir: string): void {
  if (stream) return; // already initialized
  try {
    const debugDir = join(dirname(campaignsDir), ".debug");
    mkdirSync(debugDir, { recursive: true });
    stream = createWriteStream(join(debugDir, "engine.jsonl"), { flags: "a" });
  } catch { /* best-effort */ }
}

/**
 * Log a structured event. Fire-and-forget — never throws.
 *
 * @param event — event type (e.g. "session:start", "api:error")
 * @param data — event-specific fields (merged into the log line)
 */
export function logEvent(event: string, data?: Record<string, unknown>): void {
  if (!stream) return;
  try {
    const line = JSON.stringify({ ...data, t: Date.now(), event });
    stream.write(line + "\n");
  } catch { /* never break the game */ }
}

/** Close the log stream. Called on server shutdown. Awaits flush. */
export async function closeEngineLog(): Promise<void> {
  if (!stream) return;
  const s = stream;
  stream = null;
  await new Promise<void>((resolve) => {
    s.end(() => resolve());
  });
}

/** Reset state (for tests). */
export async function resetEngineLog(): Promise<void> {
  await closeEngineLog();
}
