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
 *
 * Privacy: the log captures user keystrokes and submitted values — that's
 * the whole point — so the file is created with mode 0o600 and lives in
 * the user's per-account config dir. Each launch writes a fresh file
 * named with start timestamp + pid so logs never grow unboundedly and
 * are easy to attach to a single repro session.
 */
import { Buffer } from "node:buffer";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "../../utils/platform.js";

const LOG_DIR_ENV = "MV_INPUT_DEBUG_LOG_DIR";

let stream: WriteStream | null = null;
let resolvedPath: string | null = null;
let setupAttempted = false;
let exitHandlersRegistered = false;

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  // Best-effort flush. 'exit' is sync-only; calling end() at least drains
  // any data already in the JS-side queue. SIGINT/SIGTERM allow async work.
  const flush = () => {
    try { stream?.end(); } catch { /* ignore */ }
  };
  process.on("exit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}

function ensureStream(): WriteStream | null {
  if (stream || setupAttempted) return stream;
  setupAttempted = true;
  // Skip in unit tests — vitest workers would otherwise litter the user's
  // config dir with stray log files.
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"]) return null;
  try {
    const dir = process.env[LOG_DIR_ENV] ?? defaultConfigDir();
    mkdirSync(dir, { recursive: true });
    // Per-launch filename so logs never accumulate into one giant file.
    // Colons in ISO timestamp are illegal on Windows paths, so swap them.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `input-debug-${stamp}-${process.pid}.log`);
    // mode 0o600: log captures user input (typed text, submitted values), so
    // restrict to the owner. No-op on Windows but harmless.
    const s = createWriteStream(path, { flags: "a", mode: 0o600 });
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
    registerExitHandlers();
  } catch {
    stream = null;
  }
  return stream;
}

/** Resolved log file path, or null if logger setup failed or is disabled. */
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

/**
 * Hex-dump a string or Buffer as space-separated byte values.
 * Strings are encoded to UTF-8 first, so multibyte sequences appear as
 * their actual on-the-wire bytes rather than UTF-16 code units.
 */
export function bytesToHex(input: string | Buffer | Uint8Array): string {
  if (!input || (typeof input === "string" && input.length === 0)) return "";
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  let result = "";
  for (let i = 0; i < buf.length; i++) {
    if (i > 0) result += " ";
    result += buf[i].toString(16).padStart(2, "0");
  }
  return result;
}
