import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isDevMode } from "./dev-mode.js";

const noop = () => { /* fire-and-forget */ };

// --- Module-level state (same pattern as dev-mode.ts) ---

let dumpDir: string | null = null;

/** Accumulates thinking blocks between dumpContext() calls, keyed by agent. */
const thinkingAccumulator = new Map<string, { round: number; thinking: string; timestamp: string }[]>();

/**
 * Set the context dump output directory. Called once at campaign start.
 * Creates the directory tree (fire-and-forget).
 */
export function setContextDumpDir(dir: string): void {
  dumpDir = dir;
  void mkdir(dir, { recursive: true }).catch(noop);
}

/** Get the current dump directory (for testing). */
export function getContextDumpDir(): string | null {
  return dumpDir;
}

/** Reset state (for tests). */
export function resetContextDump(): void {
  dumpDir = null;
  thinkingAccumulator.clear();
}

// --- Types ---

/** Accepts any object — no structural assumptions about API params. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DumpableParams = Record<string, any>;

// --- Public API ---

/**
 * Dump context to a file as raw JSON. Fire-and-forget, errors swallowed.
 * Only runs when DEV_MODE is active and dumpDir has been set.
 *
 * Drains any accumulated thinking blocks for this agent and includes them
 * as `_thinking_trace` in the JSON envelope.
 */
export function dumpContext(agentName: string, params: DumpableParams): void {
  if (!isDevMode() || !dumpDir) return;

  // Snapshot accumulated thinking for this agent (don't drain — traces persist)
  const traces = [...(thinkingAccumulator.get(agentName) ?? [])];

  const envelope = {
    agent: agentName,
    timestamp: new Date().toISOString(),
    ...params,
    ...(traces.length > 0 ? { _thinking_trace: traces } : {}),
  };
  const json = JSON.stringify(envelope, null, 2);
  const filePath = join(dumpDir, `${agentName}.json`);

  void writeFile(filePath, json, "utf-8").catch(noop);
}

/**
 * Dump response thinking blocks to a separate file.
 * Writes to `{agentName}-thinking.json`. Fire-and-forget, errors swallowed.
 * Only runs when DEV_MODE is active and dumpDir has been set.
 *
 * Also accumulates the thinking block so the next dumpContext() call
 * for this agent will include it in `_thinking_trace`.
 */
export function dumpThinking(
  agentName: string,
  round: number,
  thinkingText: string,
): void {
  if (!isDevMode() || !dumpDir) return;

  const timestamp = new Date().toISOString();

  // Accumulate for next dumpContext() call
  if (!thinkingAccumulator.has(agentName)) {
    thinkingAccumulator.set(agentName, []);
  }
  thinkingAccumulator.get(agentName)?.push({ round, thinking: thinkingText, timestamp });

  // Write the full accumulated array so the file always has every trace
  const allTraces = thinkingAccumulator.get(agentName) ?? [];
  const envelope = { agent: agentName, timestamp, traces: [...allTraces] };
  const json = JSON.stringify(envelope, null, 2);
  const filePath = join(dumpDir, `${agentName}-thinking.json`);

  void writeFile(filePath, json, "utf-8").catch(noop);
}
