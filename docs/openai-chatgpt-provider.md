# openai-chatgpt Provider

The `openai-chatgpt` connection type lets users authenticate against their existing ChatGPT Plus / Pro / Business / Enterprise subscription instead of paying separately for OpenAI API credits. It drives the official `codex app-server` (an OpenAI-supported SDK harness) over JSON-RPC rather than calling `api.openai.com` directly.

## Why a subprocess

OpenAI ships [`codex app-server`](https://developers.openai.com/codex/app-server) as the documented integration path for third-party apps that want to use ChatGPT-account auth. It owns:

- The OAuth 2.0 PKCE flow (it spins up its own loopback HTTP server on `localhost:1455` for the redirect)
- ChatGPT token persistence and refresh (in `~/.codex/auth.json`)
- The required backend headers (`ChatGPT-Account-ID`, `OpenAI-Beta`, `originator`)
- Rate-limit reporting via `account/rateLimits/updated` notifications

We get all of that "for free" by spawning the binary instead of building any of it ourselves. Our `clientInfo.name` (always `machine_violet`) flows through to the OAuth `originator` query parameter, so on OpenAI's backend we are identified as Machine Violet — not Codex impersonation, not API-key abuse.

## Components

All under `packages/engine/src/providers/openai-chatgpt/`:

| File | Role |
|---|---|
| `binary.ts` | Resolves the `codex` executable. Prefers the bundled `@openai/codex` npm dependency (invoked via `process.execPath bin/codex.js`); falls back to `$CODEX_BIN` and then `PATH`. |
| `rpc.ts` | `CodexRpcClient` — newline-delimited JSON-RPC over stdio. Routes responses, notifications, and server requests; lets callers `call`, `notify`, `onNotification`, `onServerRequest`. |
| `protocol.ts` | TypeScript shapes for the subset of the JSON-RPC protocol we use. The Codex CLI ships `codex app-server generate-json-schema` which produces the canonical schemas we mirror. |
| `auth.ts` | Login flow orchestration: `startChatGptLogin`, `awaitLoginCompletion`, `cancelLogin`, `getAccount`, `logout`. |
| `models.ts` | `model/list` wrapper that normalizes `ModelInfo` → `DiscoveredCodexModel`. |
| `usage.ts` | Translates `RateLimits` payloads → generic `UsageStatus` (the cross-provider shape consumed by the Connections UI). |
| `provider.ts` | `OpenAIChatGptProvider` — the `LLMProvider` impl. Owns the subprocess, runs turns end-to-end with internal tool dispatch via `params.dispatchTool`. |
| `log.ts` | Helpers that emit `codex:*` operational events to `.debug/engine.jsonl`. |

## Lifecycle

1. **Construction** is synchronous and free — `createOpenAIChatGptProvider()` returns a provider with no subprocess yet running.
2. **First `chat()` / `stream()` call** lazily spawns codex, sends `initialize`, validates a ChatGPT account is logged in, and subscribes to rate-limit updates. Failures here clear the start promise so subsequent calls retry from scratch.
3. **Per-turn**: a fresh Codex thread is created with `developerInstructions` (system prompt) and `dynamicTools` (tool defs); prior history is pushed via `thread/inject_items`; `turn/start` runs the turn. Tool calls arrive as `item/tool/call` server requests and are dispatched via `params.dispatchTool` synchronously.
4. **`dispose()`** is called by the session manager at session end. Idempotent.

## History ownership

We **never** delegate conversation state to Codex's thread persistence. The bridge passes the full normalized history each call; the provider re-injects it into a fresh thread every time. Codex's own rollout files in `~/.codex/sessions/` become a redundant copy.

This is a deliberate tradeoff: re-injecting per turn costs a few extra tokens (mostly cached by OpenAI's automatic prefix caching) but lets Machine Violet's scribe and compaction pipeline stay the source of truth — which is what makes long campaigns work.

## Tool dispatch

Codex sends tool calls as JSON-RPC server requests (`item/tool/call`) that must be replied to synchronously to keep the turn alive. This doesn't fit the bridge's "return tool calls, run them, re-issue" pattern that other providers use. Instead, the codex provider runs the entire multi-round tool loop internally:

- The agent-loop-bridge synthesizes a `dispatchTool` callback from `config.toolHandler` (and the same TUI-broadcast / deferred-sentinel logic it uses for non-internal-dispatch providers) and passes it via `ChatParams.dispatchTool`.
- The codex provider receives each `item/tool/call`, invokes `dispatchTool`, and replies with the result as a `DynamicToolCallResponse`.
- The provider returns from `chat()` only when the turn is fully complete — with empty `toolCalls` (they were all dispatched internally).

The bridge sees a single chat() call with the final aggregated text + usage. Cost tracking, `api:call` logging, and prompt caching all work transparently.

**Persisted-history shape.** Because the provider doesn't surface `toolCalls` back to the bridge, the engine's normalized history records only the assistant's `tool_use` blocks (plus the final committed text appended after them) — there are no `tool_result` blocks, and the trailing text sits *after* the tool_use blocks. Neither shape replays cleanly: Anthropic 400s on text-after-tool_use, and any provider 400s on orphaned tool_use ids. The engine compensates inside the provider mappers via `providers/orphan-patch.ts` — see [Malformed history](error-recovery.md#malformed-history-orphan--block-order-patches) for the two heuristics and their cache invariants.

## Auth flow (server endpoints)

| Endpoint | Purpose |
|---|---|
| `POST /manage/connections/openai-chatgpt/login` | Spawns a per-login codex subprocess, calls `account/login/start`, returns `{ loginId, authUrl }`. The client opens `authUrl` in the system browser. |
| `GET /manage/connections/openai-chatgpt/login/:loginId` | Polled by the client every ~2s. Returns `{ status: "pending" \| "success" \| "error" \| "cancelled", connectionId?, email?, planType? }`. On success the connection record has already been persisted. |
| `POST /manage/connections/openai-chatgpt/login/:loginId/cancel` | Cancels a pending login and tears down its subprocess. |

The login subprocess is short-lived: it lives just long enough to drive the OAuth flow, then disposes itself. The user's actual game session spawns a fresh subprocess per session via `createProviderFromConnection`.

**Re-signing in (same menu option, repeated)** does not append a second chatgpt connection. The login success handler calls `upsertChatGptConnection`, which finds the existing chatgpt record and replaces its `chatgptAccount` fields in place with the freshly-OAuthed values — preserving the connectionId (and any user-customized label) across both same-account refresh and account-switch flows. Preserving the id is load-bearing: in-memory provider instances bind their token store to that id at construction; minting a new id would orphan them. If a session is already live and was using the chatgpt connection, its provider is disposed so the next `chat()` call lazily re-spawns codex; `pushInitialTokens` then pushes the fresh tokens via `account/login/start type:"chatgptAuthTokens"`. We do **not** pre-emptively call `account/logout` — that wipes `~/.codex/auth.json` and breaks the next session subprocess's `account/read`, since codex's chatgptAuthTokens flow augments an existing identity rather than booting a fresh one. The push itself authoritatively sets the chatgpt identity for that subprocess.

**Concurrent refresh.** OpenAI rotates the `refresh_token` on every `grant_type=refresh_token` exchange. Two callers racing past `store.load()` with the same RT would have the second 4xx with "refresh token already used." The token store coalesces concurrent `refresh()` calls onto a single in-flight exchange per `(configDir, connectionId)`; waiters resolve with the leader's result. This matters whenever multiple provider instances (DM + setup + theme-styler) share a connection, and when our pre-emptive startup refresh races codex's reactive `account/chatgptAuthTokens/refresh` server request.

**Cross-process recovery (#558).** The coalescing mutex is module-scoped, so it only guards refreshes *within one process*. Two **separate MV launches** (concurrent or consecutive) each load the same RT and race — the loser hits "refresh token already used." Rather than fail and force manual re-auth, `refresh()` self-heals: when its own exchange is rejected it re-reads `connections.json`, and if the on-disk RT has moved on from the one it tried, the winning launch already persisted a valid bundle — it adopts that instead of throwing. Only a genuine dead token (RT unchanged on disk) propagates the failure. This is the same disk-re-read trick used for the sign-in-vs-refresh race, applied to the failure path.

**Graceful degradation (#558).** A genuinely dead sign-in must drop the session to the main menu, never crash or strand the client in a dead retry overlay. Mid-game this already happens: codex's reactive refresh request fails, the turn fails as a `CodexTurnFailedError` (`kind: "auth_expired"`), and `classifyServerError` routes it to `session-fatal-recoverable`. The two paths that run a turn *outside* the player-input commit handler are wired to match: (1) `pushInitialTokens` (pre-emptive startup refresh) throws a dedicated `ChatGptAuthError` — a distinct class so `classifyServerError` routes it to `session-fatal-recoverable` by class rather than falling through to the `retryable` default; (2) the new-game opening DM turn in `SessionManager.doStartSession` is wrapped so a session-fatal failure runs the same `handleSessionFatal` teardown (flush → checkpoint → drop to menu) the mid-game path uses.

## Usage status

Both `getUsageStatus()` (cached snapshot) and `subscribeUsage(cb)` (push) are implemented. The provider listens for `account/rateLimits/updated` notifications continuously and:

1. Updates its cached `latestRateLimits`
2. Logs the snapshot to `.debug/engine.jsonl` as `codex:rate_limit:updated`
3. Fires `codex:rate_limit:warning` if any window crosses 80% used
4. Notifies any UI subscribers via the `subscribeUsage` callback

`GET /manage/connections/:id/usage` returns `{ available: true, status }` only when there's an active session backing the connection (idle connections have no subprocess to query). Returns `{ available: false }` otherwise; the UI shows no usage line.

## Operational events

All emitted via `logEvent` to `.debug/engine.jsonl`. Token counts and per-call cost data go through the existing `api:call` event in agent-loop-bridge — same as every other provider. The codex-specific events are operational only:

| Event | Payload | When |
|---|---|---|
| `codex:subprocess:spawn` | `{ binaryPath, version?, sessionId? }` | Codex child process starts |
| `codex:subprocess:initialized` | `{ userAgent?, codexHome?, platformOs?, platformArch?, sessionId? }` | `initialize` handshake completed — records codex version + platform diagnostics |
| `codex:subprocess:exit` | `{ code, signal, sessionId? }` | Codex child process dies |
| `codex:rpc:error` | `{ method, code, message, sessionId? }` | A JSON-RPC request returned an error result |
| `codex:auth:login_started` | `{ type, loginId }` | OAuth or device-code flow initiated |
| `codex:auth:login_completed` | `{ loginId, success, planType?, error? }` | Login finished (success or failure) |
| `codex:auth:token_refresh` | `{ reason, previousAccountId? }` | Codex requested a fresh ChatGPT token |
| `codex:rate_limit:updated` | `{ limitId, primary, secondary?, planType, ... }` | New `account/rateLimits/updated` arrived |
| `codex:rate_limit:warning` | `{ segmentId, usedPercent, resetsAt? }` | A window crossed 80% used |
| `codex:thread:start` | `{ threadId, model, sessionId? }` | New Codex thread created |
| `codex:turn:start` | `{ threadId, turnId?, effort? }` | A turn was dispatched |
| `codex:turn:complete` | `{ threadId, turnId, durationMs, status }` | A turn finished |

(Encrypted-reasoning capture has no dedicated event — it flows through the normal turn capture and shows up in the persisted assistant content. Matches the openai-apikey path which is also silent about reasoning blobs.)

## Reasoning preservation across turns

Reasoning-effort-enabled turns produce an opaque `encrypted_content` blob per reasoning item that the Responses API will accept back as input on subsequent turns — that's what lets the model continue its chain-of-thought instead of re-deriving setup each round. The blob is **not** exposed on codex's sanitized `item/completed` stream (the `ReasoningThreadItem` view defines only `summary` and `content` text). It surfaces on a separate notification: **`rawResponseItem/completed`**.

Capture: the provider subscribes to `rawResponseItem/completed` per turn and stores items where `item.type === "reasoning"` and `encrypted_content` is non-null. Each captured item becomes a `reasoning` ContentPart on `assistantContent`. ZDR-off codex configurations don't forward the blob, in which case the item is dropped (persisting an empty shell would replay back as an invalid input item).

Replay: `messageToResponsesItems` emits any `reasoning` ContentPart as a Responses-API `reasoning` item at the **head** of the assistant turn (before message and function_call items, as the API requires).

The same encrypted-blob round-trip is what the `openai-apikey` / `openrouter` paths use directly against the Responses API. See issue #533 for the wider cross-provider context (Anthropic uses its own `thinking` + `redacted_thinking` blocks with `signature`; `custom` Chat-Completions endpoints have no equivalent contract).

## Wire gotchas (codex 0.130.0)

- **`requiresOpenaiAuth: true`** on `account/read` is misleading — it's true even when ChatGPT auth is fine. It really signals "needs an `sk-...` API key for non-ChatGPT models." Check `account.type === "chatgpt"` instead.
- **`sandbox`** on `thread/start` is kebab-case (`"read-only"`, `"workspace-write"`, `"danger-full-access"`), even though the corresponding object types use camelCase. The generated schema misleads.
- **`DynamicToolCallResponse`** requires both `success: boolean` AND `contentItems: [{ type: "inputText" | "inputImage", ... }]`. Both fields required, strict validation.
- **`dynamicTools`** is wire-supported via `thread/start` even though it's missing from the v0.130.0 generated schema. Could churn — pin codex versions and re-validate on bumps.
- **`modelContextWindow`** returned by `thread/tokenUsage/updated` reflects per-plan caps. GPT-5.5 reports 258,400 tokens on Plus, NOT the published 1.05M. Callers that care about an accurate window must read from this notification at runtime, not from `known-models.json`.

## Distribution

`@openai/codex` is a workspace dependency in `packages/engine/package.json`, so it's pulled in by `npm install` and bundled into `node_modules/` at build time. The Node SEA build vendors `node_modules/`, so shipped binaries get codex transparently — no auto-download UX needed for the common case. Developers running from source get it via `npm install`.

`CODEX_BIN` env var overrides the bundled binary if set — useful for local builds of codex or for testing version pinning.
