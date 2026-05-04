/**
 * TEMPORARY diagnostic logger for the missed-Enter bug.
 *
 * Captures the full input pipeline as JSONL so a single reproduction
 * tells us exactly which stage swallowed the Enter byte:
 *   - stdin-raw           : bytes pulled from stdin before any filter
 *   - stdin-after-filter  : bytes the filter chain returns to Ink
 *   - kitty-extract       : CSI-u keys parsed by the kitty filter
 *   - kitty-legacy-push   : legacy bytes pushed back into stdin for Ink
 *   - inline-key          : every (input, key) Ink dispatches to InlineTextInput
 *   - inline-paste        : usePaste deliveries (bracketed-paste content)
 *   - inline-submit       : every submit() call inside InlineTextInput
 *   - inline-mount/unmount: InlineTextInput mount lifecycle
 *   - inline-disabled     : isDisabled toggled on a mounted InlineTextInput
 *
 * Logged unconditionally because the bug is intermittent and we want
 * data on every run. Remove once the underlying issue is fixed.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "../../utils/platform.js";

const LOG_DIR_ENV = "MV_INPUT_DEBUG_LOG_DIR";

let stream: WriteStream | null = null;
let resolvedPath: string | null = null;
let setupAttempted = false;

function ensureStream(): WriteStream | null {
  if (stream || setupAttempted) return stream;
  setupAttempted = true;
  try {
    const dir = process.env[LOG_DIR_ENV] ?? defaultConfigDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "input-debug.log");
    const s = createWriteStream(path, { flags: "a" });
    s.on("error", () => { /* swallow — diagnostic logging must never crash the app */ });
    stream = s;
    resolvedPath = path;
    s.write(JSON.stringify({
      ts: new Date().toISOString(),
      kind: "session-start",
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
    }) + "\n");
  } catch {
    stream = null;
  }
  return stream;
}

/** Resolved log file path, or null if logger setup failed. */
export function getInputDebugLogPath(): string | null {
  ensureStream();
  return resolvedPath;
}

/** Append a JSONL entry to the input debug log. Never throws. */
export function logInputEvent(kind: string, data: Record<string, unknown> = {}): void {
  const s = ensureStream();
  if (!s) return;
  try {
    s.write(JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      ...data,
    }) + "\n");
  } catch {
    // ignore — diagnostic logging must never crash the app
  }
}

/** Convert a string of bytes to a hex-dump string like "1b 5b 31 33 75". */
export function bytesToHex(s: string): string {
  if (!s) return "";
  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0) result += " ";
    result += s.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return result;
}
