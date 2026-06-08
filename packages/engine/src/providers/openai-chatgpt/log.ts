/**
 * Logging helpers for the openai-chatgpt provider.
 *
 * All operational events go through `logEvent` from engine-log.ts so they
 * land in the same `.debug/engine.jsonl` file as `api:call`, `api:error`,
 * etc. We use the `codex:*` namespace exclusively — `api:call` continues
 * to be emitted upstream by agent-loop-bridge.ts when our chat()/stream()
 * returns, since the NormalizedUsage contract is shared with every other
 * provider.
 *
 * Event vocabulary (keep in sync with docs/maintenance.md if added there):
 *   codex:subprocess:spawn        — child started, binary resolved
 *   codex:subprocess:initialized  — `initialize` handshake completed (records codex version + userAgent)
 *   codex:subprocess:exit         — child died (expected or otherwise)
 *   codex:subprocess:stderr       — a line codex wrote to ITS stderr (its tracing/diagnostics), captured to our log
 *   codex:rpc:error               — JSON-RPC method returned an error
 *   codex:rpc:parse_failure       — a large stdout line failed to JSON.parse (truncated/corrupt payload)
 *   codex:rpc:large_line          — an unusually large line DID parse (confirms big payloads survive transport)
 *   codex:rpc:reasoning_item_missing — model reasoned this turn but no rawResponseItem/completed arrived (likely a dropped encrypted-reasoning blob; #597)
 *   codex:auth:login_started      — OAuth/device-code flow initiated
 *   codex:auth:login_completed    — login finished (success or otherwise)
 *   codex:auth:token_refresh      — Codex requested fresh ChatGPT tokens
 *   codex:rate_limit:updated      — new rateLimits notification arrived
 *   codex:rate_limit:warning      — a window crossed 80% used
 *   codex:thread:start            — new Codex thread created
 *   codex:turn:start              — turn dispatched
 *   codex:turn:complete           — turn finished
 */
import { logEvent } from "../../context/engine-log.js";

export const log = {
  spawn: (data: { binaryPath: string; version?: string; sessionId?: string }) =>
    logEvent("codex:subprocess:spawn", data),
  initialized: (data: { userAgent?: string; codexHome?: string; platformOs?: string; platformArch?: string; sessionId?: string }) =>
    logEvent("codex:subprocess:initialized", data),
  exit: (data: { code: number | null; signal: NodeJS.Signals | null; sessionId?: string }) =>
    logEvent("codex:subprocess:exit", data),
  /**
   * One line codex wrote to its OWN stderr — a WARN/ERROR `tracing` record or
   * any non-tracing diagnostic (panic, stack frame, raw print). We pipe + drain
   * stderr (rather than `inherit`-ing it to the terminal) so these land in the
   * engine log alongside the protocol events: codex's stderr is the only place
   * its internal failures surface, and a render/tool turn that misbehaves often
   * explains itself here. ANSI color codes are stripped and long lines are
   * truncated before logging; INFO/DEBUG/TRACE records are filtered out (at
   * `RUST_LOG=info`+ they run to 100k+ lines/turn — see
   * `codexStderrLineWorthLogging`). At the default `RUST_LOG` codex's stderr is
   * near-silent, so this is rare in normal operation.
   */
  stderr: (data: { line: string; sessionId?: string }) =>
    logEvent("codex:subprocess:stderr", data),
  rpcError: (data: { method: string; code: number; message: string; sessionId?: string }) =>
    logEvent("codex:rpc:error", data),
  /**
   * A large stdout line that `JSON.parse` rejected — the smoking gun for a
   * silently-dropped payload (e.g. a multi-MB inline base64 image that arrived
   * truncated/corrupted over the pipe, making an image render "complete" with no
   * bytes and no error). NOTE: this is NOT codex's tracing — that goes to its
   * stderr (now captured as `codex:subprocess:stderr`), a separate fd that can't
   * touch the stdout protocol pipe. A non-JSON line on *stdout* is foreign bytes
   * (a codex module printing directly to stdout, or one protocol write spliced
   * into another). `head`/`tail` tell a truncated-JSON drop (starts `{`, ends
   * mid-token) from genuine noise; `methodGuess` is the `"method"` field
   * salvaged from the fragment when the head survived, so a non-image drop
   * (e.g. `rawResponseItem/completed`) is attributable instead of opaque.
   */
  parseFailure: (data: { bytes: number; head: string; tail: string; methodGuess?: string; sessionId?: string }) =>
    logEvent("codex:rpc:parse_failure", data),
  /**
   * Informational, logged ONCE per session: the model reasoned (summary deltas
   * streamed on `item/reasoning/*`) yet NOT ONE `rawResponseItem/completed`
   * reasoning item arrived on its separate channel, so the encrypted_content
   * blob we replay for cross-turn chain-of-thought (#533) got no data. Two
   * indistinguishable causes: a transport drop (no disk fallback, unlike
   * images), OR — confirmed by live test — a non-ZDR ChatGPT account, where
   * codex emits no raw reasoning items at all and #533 replay is simply a no-op.
   * A genuine intermittent drop instead surfaces as `parse_failure` with a
   * `methodGuess`; this event just makes the "replay got nothing" state visible.
   * See {@link OpenAIChatGptProvider} runTurn. (#597)
   */
  reasoningRawItemMissing: (data: { threadId: string; turnId: string; summaryDeltas: number; sessionId?: string }) =>
    logEvent("codex:rpc:reasoning_item_missing", data),
  /**
   * An unusually large line that DID parse. Confirms the transport carries big
   * payloads intact, so a byteless image turn is the backend's doing, not ours.
   */
  largeLine: (data: { bytes: number; method?: string; hasResult?: boolean; sessionId?: string }) =>
    logEvent("codex:rpc:large_line", data),
  loginStarted: (data: { type: "chatgpt" | "chatgptDeviceCode"; loginId: string }) =>
    logEvent("codex:auth:login_started", data),
  loginCompleted: (data: { loginId: string; success: boolean; planType?: string; error?: string }) =>
    logEvent("codex:auth:login_completed", data),
  tokenRefresh: (data: { reason: string; previousAccountId?: string }) =>
    logEvent("codex:auth:token_refresh", data),
  rateLimitUpdated: (data: Record<string, unknown>) =>
    logEvent("codex:rate_limit:updated", data),
  rateLimitWarning: (data: { segmentId: string; usedPercent: number; resetsAt?: number }) =>
    logEvent("codex:rate_limit:warning", data),
  threadStart: (data: { threadId: string; model: string; sessionId?: string }) =>
    logEvent("codex:thread:start", data),
  turnStart: (data: { threadId: string; turnId?: string; effort?: string }) =>
    logEvent("codex:turn:start", data),
  turnComplete: (data: {
    threadId: string;
    turnId: string;
    durationMs: number;
    status: string;
    /** Codex's own error message when status === "failed". Carries the only
     *  hint about why the turn aborted (model not found, auth issue, etc). */
    error?: string | null;
  }) => logEvent("codex:turn:complete", data),
};
