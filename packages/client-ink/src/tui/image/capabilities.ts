/**
 * Terminal graphics-capability detection for the inline-image renderer.
 *
 * We support the three real graphics protocols and pick the best available:
 * kitty > iTerm2 > sixel. Terminals with none render no inline image (the
 * full-res PNG still lives in the HTML transcript export).
 *
 * The pure parsers (response → capability) are unit-tested; the async probe
 * orchestration (`detectGraphicsCapabilities`) writes queries and reads stdin
 * responses in raw mode, modeled on `detectKittySupport` in
 * ../hooks/kittyProtocol.ts. It is sequenced after the kitty-keyboard probe at
 * startup so the two don't race on stdin.
 */

export type GraphicsProtocol = "kitty" | "iterm2" | "sixel";

export interface GraphicsCapabilities {
  kitty: boolean;
  iterm2: boolean;
  sixel: boolean;
  /** Terminal cell size in pixels; null when the terminal didn't report it. */
  cellPixels: { width: number; height: number } | null;
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
 * Pick the best protocol. kitty is cheapest/best (transmit-once, native crop,
 * flicker-free re-place); iTerm2 and sixel are the blit family. Returns null
 * when the terminal supports none.
 */
export function pickProtocol(caps: GraphicsCapabilities): GraphicsProtocol | null {
  if (caps.kitty) return "kitty";
  if (caps.iterm2) return "iterm2";
  if (caps.sixel) return "sixel";
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
): Promise<GraphicsCapabilities> {
  const iterm2 = detectIterm2FromEnv(env);
  if (!stdin.isTTY) {
    return { kitty: false, iterm2, sixel: false, cellPixels: null };
  }
  return await new Promise<GraphicsCapabilities>((resolve) => {
    let buf = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("readable", onReadable);
      resolve({
        kitty: parseKittyGraphics(buf),
        iterm2,
        sixel: parseSixelFromDeviceAttributes(buf),
        cellPixels: parseCellPixelSize(buf),
      });
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
    // cell size, then kitty graphics probe, then DA (terminator).
    stdout.write("\x1b[16t");
    stdout.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\");
    stdout.write("\x1b[c");
  });
}
