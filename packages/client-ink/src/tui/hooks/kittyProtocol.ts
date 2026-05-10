/**
 * Kitty keyboard protocol — detection, negotiation, parsing, and stdin filter.
 *
 * When a terminal supports the Kitty keyboard protocol, we enable flag 1
 * (disambiguate) so every key press gets an unambiguous CSI-u encoding.
 * This eliminates Backspace/Home/End corruption caused by ConPTY silently
 * re-enabling ENABLE_PROCESSED_INPUT on Windows (microsoft/terminal#19674).
 *
 * The stdin filter intercepts CSI-u sequences before Ink sees them, parses
 * them into structured key objects, then re-emits legacy byte sequences
 * that Ink's useInput understands. Non-Kitty terminals fall through to the
 * existing raw mode guard.
 *
 * @see https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

import type { StdinFilter } from "./stdinFilterChain.js";
import { logInputEvent } from "./inputDebugLog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KittyKey {
  /** Normalized key name: "backspace", "enter", "a", "home", etc. */
  key: string;
  /** Raw Unicode codepoint or functional key code. */
  code: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

// ---------------------------------------------------------------------------
// Protocol escape sequences
// ---------------------------------------------------------------------------

/** Query current enhancement flags. Terminal responds with CSI ? <flags> u. */
const QUERY = "\x1b[?u";
/** Push flag 1 (disambiguate) onto the terminal's enhancement stack. */
const PUSH_DISAMBIGUATE = "\x1b[>1u";
/** Pop one level from the enhancement stack. */
const POP = "\x1b[<u";

// ---------------------------------------------------------------------------
// CSI-u regex — matches all Kitty keyboard CSI-u sequences.
//
// Format: CSI keycode[:shifted[:base]] [;modifiers[:event_type]] [;text] u
// We capture keycode (group 1) and modifiers (group 2, optional).
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
const CSI_U_RE = /\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?(?:;\d+)?u/g;

/** Response to QUERY: CSI ? <flags> u */
// eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
const QUERY_RESPONSE_RE = /\x1b\[\?(\d+)u/;

// ---------------------------------------------------------------------------
// Key code → name mapping (spec §Key codes)
// ---------------------------------------------------------------------------

const SPECIAL_KEYS: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  127: "backspace",
  57348: "insert",
  57349: "delete",
  57350: "left",
  57351: "right",
  57352: "up",
  57353: "down",
  57354: "pageup",
  57355: "pagedown",
  57356: "home",
  57357: "end",
};

/** Modifier-only key codes — silently dropped by the filter. */
const MODIFIER_ONLY_KEYS = new Set([
  57358, // caps_lock
  57359, // scroll_lock
  57360, // num_lock
  57441, 57442, 57443, 57444, 57445, // left shift/ctrl/alt/super/hyper
  57446, // left meta
  57447, 57448, 57449, 57450, 57451, // right shift/ctrl/alt/super/hyper
  57452, // right meta
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Decode the modifier parameter from a CSI-u sequence.
 * The protocol encodes modifiers as `1 + bitmask`, so we subtract 1.
 */
function decodeModifiers(raw: number): { shift: boolean; ctrl: boolean; alt: boolean } {
  const m = Math.max(0, raw - 1);
  return {
    shift: !!(m & 1),
    alt: !!(m & 2),
    ctrl: !!(m & 4),
  };
}

/**
 * Parse a single CSI-u sequence into a KittyKey, or null if the key
 * should be silently ignored (modifier-only keys).
 */
export function parseKittyKey(code: number, modifiersRaw: number): KittyKey | null {
  if (MODIFIER_ONLY_KEYS.has(code)) return null;

  const mods = decodeModifiers(modifiersRaw);
  const special = SPECIAL_KEYS[code];
  const key = special ?? String.fromCodePoint(code);

  return { key, code, ...mods };
}

// ---------------------------------------------------------------------------
// Legacy re-emission — translate KittyKey into bytes Ink understands
// ---------------------------------------------------------------------------

const LEGACY_SEQUENCES: Record<string, string> = {
  backspace: "\x7f",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
};

/**
 * Convert a KittyKey back into the legacy byte(s) Ink expects.
 * Returns null for keys that have no legacy representation (Ink ignores them).
 */
export function kittyKeyToLegacy(k: KittyKey): string | null {
  // Ctrl+C → keep as-is so Ink's exitOnCtrlC works
  if (k.ctrl && k.key === "c") return "\x03";

  // Modified printable char — let Ink handle modifier detection
  if (k.key.length === 1 && !k.ctrl && !k.alt) return k.key;

  // Ctrl+<letter> — Ink expects the raw control character
  if (k.ctrl && k.key.length === 1 && !k.alt) {
    const ch = k.key.toLowerCase().codePointAt(0) ?? 0;
    if (ch >= 0x61 && ch <= 0x7a) return String.fromCodePoint(ch - 0x60);
  }

  const seq = LEGACY_SEQUENCES[k.key];
  if (seq) return seq;

  // Single printable with alt — Ink sees ESC + char
  if (k.alt && k.key.length === 1) return `\x1b${k.key}`;

  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectOptions {
  stdin: NodeJS.ReadStream;
  stdout: { write(s: string): boolean };
  timeoutMs?: number;
}

/**
 * Probe the terminal for Kitty keyboard protocol support.
 *
 * Sends `CSI ? u` and waits for a `CSI ? <flags> u` response. Returns
 * true if the terminal responds within the timeout, false otherwise.
 *
 * Must be called after raw mode is enabled (so stdin delivers escape
 * sequences rather than line-buffered input).
 */
export function detectKittySupport(opts: DetectOptions): Promise<boolean> {
  const { stdin, stdout, timeoutMs = 150 } = opts;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let buf = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }, timeoutMs);

    // Use 'readable' + read() to stay in paused mode — consistent with
    // the rest of the stdin pipeline (Ink uses readable, not 'data').
    const onReadable = () => {
      if (settled) return;
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (QUERY_RESPONSE_RE.test(buf)) {
          settled = true;
          cleanup();
          resolve(true);
          return;
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      stdin.removeListener("readable", onReadable);
    };

    stdin.on("readable", onReadable);
    stdout.write(QUERY);
  });
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

let _exitCleanup: (() => void) | null = null;

/**
 * Enable Kitty keyboard protocol (push flag 1 = disambiguate).
 * Registers exit handlers to pop the flag on shutdown, preventing the
 * terminal from being left in enhanced mode after the process exits.
 * Idempotent — calling when already enabled is a no-op.
 */
export function enableKittyProtocol(stdout: { write(s: string): boolean }): void {
  if (_exitCleanup) return; // already enabled

  stdout.write(PUSH_DISAMBIGUATE);

  // Safety net: pop on exit (covers SIGINT, uncaught exceptions, etc.)
  const onExit = () => { stdout.write(POP); };
  process.on("exit", onExit);

  _exitCleanup = () => {
    process.removeListener("exit", onExit);
  };
}

/**
 * Disable Kitty keyboard protocol (pop one level).
 * Also removes the exit safety-net handler.
 */
export function disableKittyProtocol(stdout: { write(s: string): boolean }): void {
  stdout.write(POP);
  if (_exitCleanup) {
    _exitCleanup();
    _exitCleanup = null;
  }
}

// ---------------------------------------------------------------------------
// stdin filter — intercepts read() to extract CSI-u sequences
// ---------------------------------------------------------------------------

/**
 * Extract all CSI-u sequences from a string, returning parsed keys and
 * the remainder with sequences stripped out.
 */
export function extractKittyKeys(data: string): { keys: KittyKey[]; remainder: string | null } {
  const keys: KittyKey[] = [];
  const re = new RegExp(CSI_U_RE.source, CSI_U_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = re.exec(data)) !== null) {
    const code = parseInt(m[1], 10);
    const modsRaw = m[2] ? parseInt(m[2], 10) : 1; // default = 1 (no modifiers)
    const parsed = parseKittyKey(code, modsRaw);
    if (parsed) keys.push(parsed);
  }

  const stripped = data.replace(re, "");
  const remainder = stripped.length === 0 ? null : stripped.length === data.length ? data : stripped;

  return { keys, remainder };
}

/**
 * Create a StdinFilter that intercepts CSI-u sequences. Parsed keys
 * are dispatched via `onKey`, deferred with process.nextTick so the
 * chain's read() returns before any React re-rendering.
 */
export function createKittyFilter(onKey: (key: KittyKey) => void): StdinFilter {
  return {
    name: "kitty",
    process(data: string): string | null {
      const { keys, remainder } = extractKittyKeys(data);
      if (keys.length > 0) {
        logInputEvent("kitty-extract", {
          keyCount: keys.length,
          keys: keys.map((k) => ({
            key: k.key,
            code: k.code,
            shift: k.shift,
            ctrl: k.ctrl,
            alt: k.alt,
          })),
          remainderLen: remainder?.length ?? 0,
        });
        process.nextTick(() => {
          for (const key of keys) {
            logInputEvent("kitty-dispatch", {
              key: key.key,
              code: key.code,
              shift: key.shift,
              ctrl: key.ctrl,
              alt: key.alt,
            });
            onKey(key);
          }
        });
      }
      return remainder;
    },
  };
}
