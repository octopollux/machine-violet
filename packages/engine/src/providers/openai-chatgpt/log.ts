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
 *   codex:subprocess:exit         — child died (expected or otherwise)
 *   codex:rpc:error               — JSON-RPC method returned an error
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
  exit: (data: { code: number | null; signal: NodeJS.Signals | null; sessionId?: string }) =>
    logEvent("codex:subprocess:exit", data),
  rpcError: (data: { method: string; code: number; message: string; sessionId?: string }) =>
    logEvent("codex:rpc:error", data),
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
  turnComplete: (data: { threadId: string; turnId: string; durationMs: number; status: string }) =>
    logEvent("codex:turn:complete", data),
};
