import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isDevMode } from "./dev-mode.js";

const noop = () => { /* fire-and-forget */ };

// --- Module-level state (same pattern as dev-mode.ts) ---

let dumpDir: string | null = null;

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
}

// --- Types ---

/** Accepts any object — no structural assumptions about API params. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DumpableParams = Record<string, any>;

// --- Public API ---

/**
 * Dump context to a file as raw JSON. Fire-and-forget, errors swallowed.
 * Only runs when DEV_MODE is active and dumpDir has been set.
 */
export function dumpContext(agentName: string, params: DumpableParams): void {
  if (!isDevMode() || !dumpDir) return;

  const envelope = { agent: agentName, timestamp: new Date().toISOString(), ...params };
  const json = JSON.stringify(envelope, null, 2);
  const filePath = join(dumpDir, `${agentName}.json`);

  void writeFile(filePath, json, "utf-8").catch(noop);
}

/**
 * Dump response thinking blocks to a separate file.
 * Writes to `{agentName}-thinking.json`. Fire-and-forget, errors swallowed.
 * Only runs when DEV_MODE is active and dumpDir has been set.
 */
export function dumpThinking(
  agentName: string,
  round: number,
  thinkingText: string,
): void {
  if (!isDevMode() || !dumpDir) return;

  const envelope = { agent: agentName, round, timestamp: new Date().toISOString(), thinking: thinkingText };
  const json = JSON.stringify(envelope, null, 2);
  const filePath = join(dumpDir, `${agentName}-thinking.json`);

  void writeFile(filePath, json, "utf-8").catch(noop);
}
