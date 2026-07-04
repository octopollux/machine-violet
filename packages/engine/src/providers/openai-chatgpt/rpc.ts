/**
 * JSON-RPC client over a `codex app-server` subprocess.
 *
 * Wire format: newline-delimited JSON objects on stdin/stdout per the
 * Codex app-server contract. Each object omits the `"jsonrpc": "2.0"`
 * header on the wire by convention but we include it on the way out for
 * compatibility with strict servers.
 *
 * Three message types flow over the same pipe:
 *   1. Our requests       — { id, method, params } → server replies with same id
 *   2. Server notifications — { method, params } (no id), one-way
 *   3. Server requests    — { id, method, params } we must reply to
 *
 * The client routes:
 *   - Responses (matching id from our outbound) → resolve/reject the pending Promise
 *   - Notifications → fan out to subscribed listeners
 *   - Server requests → invoke registered handler and send reply
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { resolveCodexBinary } from "./binary.js";
import { log } from "./log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationHandler<P = unknown> = (params: P) => void;
export type ServerRequestHandler<P = unknown, R = unknown> = (params: P) => Promise<R>;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  startedAt: number;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A line that fails `JSON.parse` and is at least this many bytes is treated as
 * a dropped/corrupt payload and logged, not silently ignored. Below it we stay
 * quiet to avoid spam from the occasional short non-JSON line on stdout. (Codex
 * tracing is NOT the source of those — it goes to codex's stderr, which we drain
 * to the engine log separately; see {@link handleLine} and the spawn below.)
 * 4 KB is well above any stray short line yet far below an inline image payload.
 */
const RPC_PARSE_FAIL_LOG_MIN_BYTES = 4 * 1024;

/** Strip SGR (color) escape sequences from a codex stderr line before logging. */
// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
/** Cap each logged stderr line so a panic backtrace can't bloat one log entry. */
const STDERR_LINE_MAX_CHARS = 4000;

/**
 * Per-spawn feature disables for codex's app-server. MV uses NONE of codex's
 * plugin system (we pass our own `dynamicTools` on `thread/start`) or its shell
 * tooling (we run `sandbox: "read-only"`), so leaving these on is pure waste:
 *  - `plugins` re-reads + re-validates every plugin manifest under `~/.codex`
 *    on every turn (240+ WARN lines in one live session against a single
 *    malformed user plugin) and fires a startup remote-sync that 401s.
 *  - `shell_snapshot` attempts a shell-environment snapshot per `thread/start`
 *    that isn't even supported on PowerShell.
 * Disabling both is transient — `--disable X` is the `-c features.X=false`
 * equivalent, NOT a write to `~/.codex/config.toml` — and was A/B-verified to
 * eliminate the noise and the work behind it with no protocol impact. See
 * docs/openai-chatgpt-provider.md (Transport reliability) and #597.
 */
const CODEX_LEAN_FLAGS = ["--disable", "plugins", "--disable", "shell_snapshot"];

/**
 * A line that *parses* and is at least this large is noted (with its method) so
 * we can confirm big payloads — chiefly inline base64 images — survive the
 * stdio pipe intact. Ordinary protocol messages are well under 256 KB.
 */
const RPC_LARGE_LINE_LOG_MIN_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CodexRpcClientOptions {
  /** Optional sessionId for log correlation. */
  sessionId?: string;
  /** Codex CLI args after `app-server`. Default: empty (stdio transport). */
  extraArgs?: string[];
}

export class CodexRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private rlErr: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private notifListeners = new Map<string, Set<NotificationHandler>>();
  private serverHandlers = new Map<string, ServerRequestHandler>();
  private exited = false;
  private startPromise: Promise<void> | null = null;
  private readonly sessionId?: string;
  private readonly extraArgs: string[];

  constructor(opts: CodexRpcClientOptions = {}) {
    super();
    this.sessionId = opts.sessionId;
    this.extraArgs = opts.extraArgs ?? [];
  }

  /** Spawn the subprocess and resolve when it has emitted the first byte. */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const bin = resolveCodexBinary();
    log.spawn({ binaryPath: bin.path, sessionId: this.sessionId });

    this.proc = spawn(bin.path, [...bin.prefixArgs, "app-server", ...CODEX_LEAN_FLAGS, ...this.extraArgs], {
      // Pipe stderr (not `inherit`) so codex's own diagnostics land in the
      // engine log instead of vanishing to the terminal — see handleStderrLine.
      stdio: ["pipe", "pipe", "pipe"],
      env: bin.extraEnv ? { ...process.env, ...bin.extraEnv } : process.env,
      // `.cmd` shims on Windows (used by PATH-resolved global installs) need
      // shell resolution. Bundled-mode invokes node directly so shell is off.
      shell: process.platform === "win32" && bin.source === "path",
    });

    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      log.exit({ code, signal, sessionId: this.sessionId });
      // Reject all pending calls — the subprocess will not reply now.
      const dead = new Error(`codex app-server exited (code=${code} signal=${signal})`);
      for (const p of this.pending.values()) p.reject(dead);
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error("codex app-server spawn produced no stdio pipes");
    }

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    // Drain codex's stderr into the engine log. stderr is where codex's
    // `tracing` subscriber writes (INFO/WARN/ERROR) plus any direct diagnostics
    // — the only window into a render/tool turn that misbehaves. We must READ it
    // continuously (not merely pipe it) or the OS pipe buffer fills and codex
    // blocks on a stderr write; readline drains it. It's a SEPARATE fd from the
    // stdout protocol pipe, so it never corrupts our JSON — confirmed
    // empirically while investigating #597 (codex tracing was wrongly suspected
    // of splicing into stdout; it does not).
    if (this.proc.stderr) {
      this.rlErr = createInterface({ input: this.proc.stderr });
      this.rlErr.on("line", (line) => this.handleStderrLine(line));
    }

    // Wait for the process to actually be running. The first message we
    // expect after spawn is one of our own — there's no "ready" signal
    // from the server itself. Returning here lets the caller send the
    // initialize request.
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON line on stdout. This is NOT codex's tracing — that goes to
      // codex's stderr (drained to the engine log in handleStderrLine) on a
      // separate fd that can't reach this pipe, confirmed empirically (#597).
      // So a non-JSON line here is foreign bytes on the protocol stream: a codex
      // module printing directly to stdout, or — for a *large* line — a multi-MB
      // payload (typically an inline base64 image) that arrived truncated/
      // corrupted, the silent drop that makes an image render "complete" with no
      // bytes and no error. Short lines we ignore to avoid spam; a large one we
      // surface loudly with enough of the line to tell a truncated-JSON drop
      // from genuine noise, plus the salvaged `method` so a non-image drop is
      // attributable by its method name rather than opaque. Measure actual UTF-8
      // bytes off the pipe, not
      // `line.length` (UTF-16 code units) — threshold and logged `bytes` are
      // both wire size (identical for all-ASCII base64, honest for non-ASCII).
      const byteLen = Buffer.byteLength(line, "utf8");
      if (byteLen >= RPC_PARSE_FAIL_LOG_MIN_BYTES) {
        const methodGuess = salvageMethod(line);
        log.parseFailure({
          bytes: byteLen,
          head: line.slice(0, 200),
          tail: line.slice(-200),
          ...(methodGuess ? { methodGuess } : {}),
          sessionId: this.sessionId,
        });
      }
      return;
    }

    // A large line that *did* parse: note it (with method) so we can confirm
    // big base64 payloads survive the transport intact. If we see a 256 KB+
    // `item/completed` parse cleanly yet the render still yields no bytes, the
    // loss is the backend's, not the pipe's. Byte count, not code-unit count
    // (see parse-failure branch). Runs per parsed line, but Buffer.byteLength is
    // a fast O(n) scan over short messages — negligible next to the JSON.parse
    // that just ran on the same string.
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes >= RPC_LARGE_LINE_LOG_MIN_BYTES) {
      log.largeLine({
        bytes: lineBytes,
        method: msg.method,
        hasResult: msg.result !== undefined,
        sessionId: this.sessionId,
      });
    }

    // Response to one of our calls
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error) {
        log.rpcError({
          method: pending.method,
          code: msg.error.code,
          message: msg.error.message,
          sessionId: this.sessionId,
        });
        pending.reject(new CodexRpcError(pending.method, msg.error.code, msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request — we must reply
    if (msg.id !== undefined && msg.method) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      this.handleServerRequest(id, msg.method, msg.params).catch((err) => {
        // Defensive — shouldn't happen since handleServerRequest catches itself
        this.replyError(id, -32603, err instanceof Error ? err.message : String(err));
      });
      return;
    }

    // Notification
    if (msg.method) {
      const listeners = this.notifListeners.get(msg.method);
      if (listeners) {
        for (const cb of listeners) cb(msg.params);
      }
    }
  }

  /**
   * Forward one line of codex's stderr to the engine log. Strips ANSI color
   * codes (codex's tracing subscriber emits SGR-colored records), filters to the
   * diagnostic levels (see {@link codexStderrLineWorthLogging}), and caps the
   * length so a panic backtrace can't bloat a single log entry. Never consumed
   * as protocol; this is diagnostics only.
   */
  private handleStderrLine(line: string): void {
    const clean = line.replace(ANSI_SGR_RE, "").trimEnd();
    if (!clean || !codexStderrLineWorthLogging(clean)) return;
    // Cap the FULL logged line — suffix included — at STDERR_LINE_MAX_CHARS.
    const suffix = "…[truncated]";
    const capped = clean.length > STDERR_LINE_MAX_CHARS
      ? clean.slice(0, STDERR_LINE_MAX_CHARS - suffix.length) + suffix
      : clean;
    log.stderr({ line: capped, sessionId: this.sessionId });
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.serverHandlers.get(method);
    if (!handler) {
      this.replyError(id, -32601, `no handler registered for ${method}`);
      return;
    }
    try {
      const result = await handler(params);
      this.replySuccess(id, result);
    } catch (err) {
      this.replyError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Whether the subprocess has exited (either via our {@link stop} or on its
   * own). Once true this client is dead for good — the owner must drop it and
   * spawn a fresh one. Lets a caller decide, without matching on error message
   * strings, whether a thrown error was a subprocess death worth respawning for.
   */
  get hasExited(): boolean {
    return this.exited;
  }

  /** Send a request and await the typed response. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.exited) throw new Error("codex app-server has exited; call stop()/start() to restart");
    if (!this.proc || !this.proc.stdin) throw new Error("codex app-server not started; call start() first");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        method,
        startedAt: Date.now(),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params: unknown = {}): void {
    if (this.exited) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Subscribe to notifications by method name. Returns an unsubscribe fn. */
  onNotification<P = unknown>(method: string, cb: NotificationHandler<P>): () => void {
    let set = this.notifListeners.get(method);
    if (!set) {
      set = new Set();
      this.notifListeners.set(method, set);
    }
    set.add(cb as NotificationHandler);
    return () => set.delete(cb as NotificationHandler);
  }

  /** Register a handler for a server-initiated request method. */
  onServerRequest<P = unknown, R = unknown>(method: string, handler: ServerRequestHandler<P, R>): () => void {
    this.serverHandlers.set(method, handler as ServerRequestHandler);
    return () => this.serverHandlers.delete(method);
  }

  /** Gracefully shut down the subprocess. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) return;
    return new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      // SIGTERM gives codex a chance to flush; fall back to SIGKILL after 2s.
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!this.exited) proc.kill("SIGKILL");
      }, 2000).unref();
    });
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private write(msg: JsonRpcMessage): void {
    if (!this.proc || !this.proc.stdin) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private replySuccess(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/**
 * Best-effort recovery of the JSON-RPC `"method"` from a line that failed to
 * parse. A corrupted large line is usually truncated at the *tail* (the head
 * survives), and `method` sits near the front of every notification, so this
 * salvages it often enough to attribute a drop to a message type (#597).
 * Scans only the head — `method` is never deep in a multi-MB payload. Returns
 * undefined if no plausible method token is present.
 */
function salvageMethod(line: string): string | undefined {
  const m = /"method"\s*:\s*"([^"\\]{1,80})"/.exec(line.slice(0, 1024));
  return m ? m[1] : undefined;
}

/**
 * Decide whether an (already ANSI-stripped) codex stderr line is worth logging.
 * codex's tracing format is `<ts> <LEVEL> <target>: <msg>`. At `RUST_LOG=info`
 * the per-request INFO span records alone run to 100k+ lines per turn (measured
 * live, #597) — each a synchronous append that would flood the engine log and
 * slow the game. We keep **WARN/ERROR** (the diagnostic signal, including the
 * "ERROR records from dynamic_tools" the issue is about) and drop TRACE/DEBUG/
 * INFO. A line that does NOT match the tracing format (a panic, a stack frame,
 * a raw print) is **kept** — anomalous codex output is exactly what we don't
 * want to silently drop. At the default `RUST_LOG` codex's stderr is near-silent
 * regardless, so this only matters when someone raises the level for debugging.
 */
export function codexStderrLineWorthLogging(clean: string): boolean {
  const m = /^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/.exec(clean);
  if (!m) return true; // not a recognizable tracing record — keep it
  return m[1] === "WARN" || m[1] === "ERROR";
}

export class CodexRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly rpcMessage: string,
  ) {
    super(`${method} failed [${code}]: ${rpcMessage}`);
    this.name = "CodexRpcError";
  }
}
