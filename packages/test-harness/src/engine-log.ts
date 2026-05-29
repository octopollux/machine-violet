/**
 * Engine log reader for probes.
 *
 * The engine appends a JSONL event stream to `<dirname(campaignsDir)>/.debug/engine.jsonl`
 * (see packages/engine/src/context/engine-log.ts). This module reads + parses
 * that file so probes can assert against structured events — far more
 * reliable than scraping stdout, and far more diagnostic than scraping
 * ClientState.
 *
 * Events look like:
 *   {"event":"image_gen:tool_registered","t":1716800000000,"model":"gpt-5.5",...}
 *
 * Reads are best-effort: a missing file returns `[]` (the engine hasn't
 * logged anything yet), malformed lines are skipped silently. Probes
 * should `waitForEngineEvent` rather than reading once and asserting,
 * because the engine writes asynchronously.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { pollUntil, type WaitOptions } from "./wait.js";

export interface EngineLogEvent {
  /** Event name — convention is `subsystem:verb`, e.g. `image_gen:completed`. */
  event: string;
  /** Wall-clock timestamp (ms since epoch) the engine emitted the event. */
  t: number;
  /** Arbitrary event-specific payload. */
  [key: string]: unknown;
}

/** Where the engine writes its log given a campaigns directory. */
export function engineLogPath(campaignsDir: string): string {
  return join(dirname(campaignsDir), ".debug", "engine.jsonl");
}

/**
 * Read all events from the engine log. Missing file → empty array.
 * Malformed lines are silently skipped (defense against partial flushes
 * if the harness reads while the engine is mid-write).
 */
export function readEngineLog(campaignsDir: string): EngineLogEvent[] {
  const path = engineLogPath(campaignsDir);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: EngineLogEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EngineLogEvent;
      if (typeof parsed?.event === "string") out.push(parsed);
    } catch {
      // Partial write or malformed — skip.
    }
  }
  return out;
}

/** Filter events to those matching a specific event name. */
export function findEngineEvents(
  events: EngineLogEvent[],
  name: string,
): EngineLogEvent[] {
  return events.filter((e) => e.event === name);
}

/**
 * Wait until at least one event matching the predicate appears in the
 * engine log. The predicate can be a string (event name exact match) or
 * a function. Returns the first matching event.
 *
 * Engine flushes its log async via createWriteStream, so even after the
 * engine "did the thing" the line may not be visible to readEngineLog
 * for a poll tick or two. The default 200 ms poll is fine for that.
 */
export async function waitForEngineEvent(
  campaignsDir: string,
  match: string | ((e: EngineLogEvent) => boolean),
  opts: Omit<WaitOptions, "description"> & { description?: string } = {},
): Promise<EngineLogEvent> {
  const predicate = typeof match === "function"
    ? match
    : (e: EngineLogEvent) => e.event === match;
  const description = opts.description ?? `engine-log event: ${typeof match === "string" ? match : "<predicate>"}`;
  const events = await pollUntil(
    async () => readEngineLog(campaignsDir),
    (e) => e.some(predicate),
    { description, ...opts },
  );
  const match2 = events.find(predicate);
  if (!match2) {
    // Defensive — pollUntil only returns when the predicate succeeds, so
    // `find` is guaranteed to hit. Throwing keeps the type checker happy
    // without the non-null assertion the lint config bans.
    throw new Error(`waitForEngineEvent: matched in some() but missed in find() — ${description}`);
  }
  return match2;
}

/**
 * Format a compact one-line summary of an event for logging. Trims
 * payload to keep diagnostics readable.
 */
export function formatEngineEvent(e: EngineLogEvent): string {
  const { event, t, ...rest } = e;
  const ts = new Date(t).toISOString().slice(11, 23); // HH:MM:SS.sss
  const payload = JSON.stringify(rest);
  const trimmed = payload.length > 200 ? payload.slice(0, 197) + "..." : payload;
  return `[${ts}] ${event} ${trimmed}`;
}
