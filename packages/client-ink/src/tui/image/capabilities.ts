/**
 * Terminal graphics-capability detection for the inline-image renderer.
 *
 * We support the three real graphics protocols and pick the best available:
 * kitty > iTerm2 > sixel. Terminals with none render no inline image (the
 * full-res PNG still lives in the HTML transcript export).
 *
 * The path is layered so each concern stays small and adding a terminal is
 * additive, not a new branch in the middle of the logic:
 *
 *   1. Pure PARSERS    — one per query reply (`parseKittyGraphics`, …). Add a
 *                        new query → add a parser. Unit-tested in isolation.
 *   2. parseGraphicsCapabilities — assembles raw caps from the probe buffer +
 *                        env. Pure; the async probe just feeds it the buffer.
 *   3. TERMINAL_QUIRKS — a declarative table of per-terminal workarounds for
 *                        terminals that lie about / botch a capability. Adding a
 *                        weird terminal is one entry (name/reason/match/apply),
 *                        composed over the raw caps — never an inline special case.
 *   4. pickProtocol    — the priority ladder over the (quirk-adjusted) caps.
 *
 * Only the probe ORCHESTRATION (`detectGraphicsCapabilities`) is impure: it
 * writes queries and reads stdin in raw mode (modeled on `detectKittySupport`
 * in ../hooks/kittyProtocol.ts), sequenced after the kitty-keyboard probe at
 * startup so the two don't race on stdin.
 */

export type GraphicsProtocol = "kitty" | "iterm2" | "sixel";

export interface GraphicsCapabilities {
  kitty: boolean;
  /** Raw DA "attribute 4" — sixel-capable. Gate usage via pickProtocol (needs >=256 registers). */
  iterm2: boolean;
  sixel: boolean;
  /** Terminal cell size in pixels; null when the terminal didn't report it. */
  cellPixels: { width: number; height: number } | null;
  /**
   * Max sixel color registers from XTSMGRAPHICS, or null if unreported.
   * <256 means the terminal's sixel palette is too small to look good, so we
   * disable sixel entirely (render nothing → the export keeps full fidelity).
   */
  sixelColorRegisters: number | null;
}

/** Universal floor: terminals below this many registers don't get sixel. */
export const MIN_SIXEL_REGISTERS = 256;
/** Cap palette size: 1024 kills most banding; bigger payloads aren't worth it at thumbnail sizes. */
export const MAX_SIXEL_REGISTERS = 1024;

/** Effective sixel palette size for a terminal: clamp(reported ?? 256, 256, 1024). */
export function sixelPaletteSize(caps: GraphicsCapabilities): number {
  const regs = caps.sixelColorRegisters ?? MIN_SIXEL_REGISTERS;
  return Math.max(MIN_SIXEL_REGISTERS, Math.min(MAX_SIXEL_REGISTERS, regs));
}

// --- Pure parsers -----------------------------------------------------------

/**
 * Sixel support from a Primary Device Attributes reply (`\x1b[c` →
 * `\x1b[?...c`). Attribute "4" in the semicolon list means sixel graphics.
 */
export function parseSixelFromDeviceAttributes(response: string): boolean {
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  const m = response.match(/\x1b\[\?([0-9;]+)c/);
  if (!m) return false;
  return m[1].split(";").includes("4");
}

/**
 * Kitty graphics support: the query `\x1b_Gi=…` returns a response containing
 * "OK" when the terminal speaks the kitty graphics protocol.
 */
export function parseKittyGraphics(response: string): boolean {
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  return /\x1b_G[^\x1b]*OK/.test(response);
}

/**
 * Cell pixel size from a `\x1b[16t` reply: `\x1b[6;{height};{width}t`.
 * Returns null on the `\x1b[14t`-style or absent/garbled reply.
 */
export function parseCellPixelSize(response: string): { width: number; height: number } | null {
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  const m = response.match(/\x1b\[6;(\d+);(\d+)t/);
  if (!m) return null;
  const height = Number.parseInt(m[1], 10);
  const width = Number.parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Text-area pixel size from a `\x1b[14t` reply: `\x1b[4;{height};{width}t`.
 * Dividing by the terminal's char dimensions yields the cell size on terminals
 * that answer 14t but not 16t (notably iTerm2). Returns null when absent.
 */
export function parseTextAreaPixelSize(response: string): { width: number; height: number } | null {
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  const m = response.match(/\x1b\[4;(\d+);(\d+)t/);
  if (!m) return null;
  const height = Number.parseInt(m[1], 10);
  const width = Number.parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Derive cell pixel size from a text-area pixel report (`14t`) divided by the
 * terminal's char dimensions — the fallback when a terminal doesn't answer the
 * direct cell-size query (`16t`). Returns null on missing/degenerate input.
 */
export function deriveCellPixels(
  textArea: { width: number; height: number } | null,
  cols: number,
  rows: number,
): { width: number; height: number } | null {
  if (!textArea || cols <= 0 || rows <= 0) return null;
  const width = Math.round(textArea.width / cols);
  const height = Math.round(textArea.height / rows);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Max sixel color registers from an XTSMGRAPHICS reply:
 * `CSI ? 1 ; 0 ; <max> S` (Pi=1 color registers, Ps=0 success). Returns null on
 * error status / absent reply.
 */
export function parseColorRegisters(response: string): number | null {
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  const m = response.match(/\x1b\[\?1;0;(\d+)S/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * iTerm2 inline-image support is detected from environment, not a query
 * (iTerm2 has no capability handshake). Mirrors ink-picture's TerminalInfo
 * sniffing: iTerm2 itself, recent WezTerm, recent Konsole, recent Rio.
 */
export function detectIterm2FromEnv(env: NodeJS.ProcessEnv): boolean {
  const prog = env.TERM_PROGRAM;
  if (prog === "iTerm.app") return true;
  if (prog === "WezTerm") {
    const date = Number.parseInt((env.TERM_PROGRAM_VERSION ?? "").split("-")[0] ?? "", 10);
    return Number.isFinite(date) && date >= 20220319;
  }
  if (env.KONSOLE_VERSION) {
    const v = Number.parseInt(env.KONSOLE_VERSION, 10);
    return Number.isFinite(v) && v >= 220400;
  }
  return false;
}

/**
 * Assemble raw capabilities from a collected probe-reply buffer + env, before
 * any per-terminal quirks. Pure and unit-testable; the async probe orchestration
 * just feeds it the buffer it gathered. (iTerm2 has no query handshake, so it's
 * sniffed from env; everything else comes from the reply buffer.)
 */
export function parseGraphicsCapabilities(
  buf: string,
  env: NodeJS.ProcessEnv,
  cols: number,
  rows: number,
): GraphicsCapabilities {
  return {
    kitty: parseKittyGraphics(buf),
    iterm2: detectIterm2FromEnv(env),
    sixel: parseSixelFromDeviceAttributes(buf),
    // Prefer the direct cell-size report (16t); fall back to text-area pixels
    // (14t) ÷ char dims for terminals that only answer 14t (iTerm2).
    cellPixels: parseCellPixelSize(buf) ?? deriveCellPixels(parseTextAreaPixelSize(buf), cols, rows),
    sixelColorRegisters: parseColorRegisters(buf),
  };
}

// --- Terminal quirks (per-terminal workarounds) -----------------------------

/**
 * A workaround for one terminal whose advertised capabilities don't match
 * reality. `match` identifies it (usually from env); `apply` returns adjusted
 * capabilities. Quirks COMPOSE — every matching quirk's `apply` runs in order —
 * so supporting another weird terminal is a single entry in TERMINAL_QUIRKS,
 * never a new branch in the detection/resolution logic.
 *
 * Keep `reason` specific: it's the only record of why each workaround exists.
 */
export interface TerminalQuirk {
  /** Terminal name, for documentation and debugging. */
  readonly name: string;
  /** Why this workaround exists. */
  readonly reason: string;
  /** True when this quirk applies to the current terminal. */
  match(env: NodeJS.ProcessEnv): boolean;
  /** Return adjusted capabilities — do not mutate the input. */
  apply(caps: GraphicsCapabilities): GraphicsCapabilities;
}

export const TERMINAL_QUIRKS: readonly TerminalQuirk[] = [
  {
    name: "iTerm2",
    reason:
      "Ships a partial kitty-graphics implementation that mis-scales source " +
      "crops (scales a band into a fixed box instead of cropping 1:1) and drops " +
      "image data on placement delete. Its native inline-image protocol is solid " +
      "on its own terminal, so disable kitty and let pickProtocol fall to iterm2.",
    match: (env) => env.TERM_PROGRAM === "iTerm.app",
    apply: (caps) => ({ ...caps, kitty: false }),
  },
];

/** Compose every matching terminal quirk over the raw detected capabilities. */
export function applyTerminalQuirks(
  caps: GraphicsCapabilities,
  env: NodeJS.ProcessEnv,
): GraphicsCapabilities {
  return TERMINAL_QUIRKS.reduce((c, quirk) => (quirk.match(env) ? quirk.apply(c) : c), caps);
}

/**
 * Pick the best protocol. kitty is cheapest/best (transmit-once, native crop,
 * flicker-free re-place); iTerm2 and sixel are the blit family. Returns null
 * when the terminal supports none.
 */
export function pickProtocol(caps: GraphicsCapabilities): GraphicsProtocol | null {
  if (caps.kitty) return "kitty";
  if (caps.iterm2) return "iterm2";
  // Sixel only if the palette is big enough to look decent. A terminal that
  // reports <256 registers is treated as not supporting images (a null/
  // unreported count is assumed to be the 256 floor and allowed through).
  if (caps.sixel && (caps.sixelColorRegisters ?? MIN_SIXEL_REGISTERS) >= MIN_SIXEL_REGISTERS) return "sixel";
  return null;
}

// --- Async probe orchestration (impure; not unit-tested) --------------------

/**
 * Minimal stdin shape — matches Node's tty.ReadStream. We use `readable` +
 * `read()` (paused mode), consistent with `detectKittySupport` and the rest of
 * the stdin pipeline, so we never flip the stream to flowing mode and steal
 * bytes Ink will need once it starts reading.
 */
export interface ProbeStdin {
  isTTY?: boolean;
  on(event: "readable", listener: () => void): unknown;
  removeListener(event: "readable", listener: () => void): unknown;
  read(): Buffer | string | null;
}
export interface ProbeStdout {
  write(s: string): boolean;
}

// DA reply (`\x1b[?...c`) is the natural terminator — it's the last query we
// send, so once it arrives the kitty/cell-size replies (sent first) are in.
// eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
const DA_REPLY_RE = /\x1b\[\?[0-9;]+c/;

/**
 * Send the graphics + cell-size queries and parse the aggregated reply.
 * Emits all queries, then collects stdin until the DA terminator or timeout.
 * Falls back to all-false / null cell size on timeout or non-TTY.
 *
 * Must run after raw mode is enabled and before Ink starts consuming stdin
 * (i.e. before render()), sequenced after the kitty-keyboard probe.
 */
export async function detectGraphicsCapabilities(
  stdin: ProbeStdin,
  stdout: ProbeStdout,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 250,
  cols: number = process.stdout.columns ?? 80,
  rows: number = process.stdout.rows ?? 24,
): Promise<GraphicsCapabilities> {
  // Resolve raw capabilities from a probe buffer, then apply per-terminal
  // quirks. "" → no replies (non-TTY / timeout): env-sniffed caps only.
  const resolveCaps = (buf: string): GraphicsCapabilities =>
    applyTerminalQuirks(parseGraphicsCapabilities(buf, env, cols, rows), env);

  if (!stdin.isTTY) {
    return resolveCaps("");
  }
  return await new Promise<GraphicsCapabilities>((resolve) => {
    let buf = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("readable", onReadable);
      resolve(resolveCaps(buf));
    };
    const onReadable = () => {
      if (settled) return;
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) {
        buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      }
      if (DA_REPLY_RE.test(buf)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("readable", onReadable);
    // cell size (16t), text-area pixels (14t, cell-size fallback), kitty
    // graphics probe, XTSMGRAPHICS max color registers, then DA (terminator —
    // sent last so its reply means the others are in).
    stdout.write("\x1b[16t");
    stdout.write("\x1b[14t");
    stdout.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
    stdout.write("\x1b[?1;4;0S");
    stdout.write("\x1b[c");
  });
}
