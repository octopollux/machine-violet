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

**Persisted-history shape.** Codex returns the whole turn as ONE collapsed assistant message — `tool_use` blocks followed by the final text — with empty `toolCalls`. Left as-is this replays badly (Anthropic 400s on text-after-tool_use; any provider 400s on orphaned tool_use ids). Rather than patch the broken shape after the fact, the bridge **normalizes the turn** before returning it (`providers/normalize-turn.ts`): it captures the real tool results out of band (the `dispatchTool` closure records each `{ tool_use_id, content, is_error }`) and rebuilds the canonical sequence `assistant([reasoning?, tool_use*])` → `user([tool_result*])` → `assistant([text])`. The narration moves to the final assistant message so it appears **once** (the prior shape duplicated it), and tool_use blocks are paired with the **real** results — not the `[no tool result recorded]` stubs that healing would otherwise synthesize. The result is identical in shape to the loop-style providers, and the engine stores it verbatim without inspecting it. The invariant is locked by `providers/normalized-turn.contract.test.ts`. `providers/orphan-patch.ts` remains as a defensive net for *legacy* histories written before normalization — see [Malformed history](error-recovery.md#malformed-history-orphan--block-order-patches).

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
| `codex:subprocess:stderr` | `{ line, sessionId? }` | One WARN/ERROR line (or non-tracing diagnostic) codex wrote to its own stderr, captured to our log instead of `inherit`-ed to the terminal. ANSI-stripped, length-capped; INFO/DEBUG/TRACE filtered out (they flood at `RUST_LOG=info`+). Near-silent at the default `RUST_LOG`. |
| `codex:rpc:error` | `{ method, code, message, sessionId? }` | A JSON-RPC request returned an error result |
| `codex:rpc:reasoning_item_missing` | `{ threadId, turnId, summaryDeltas, sessionId? }` | **Once per session.** Model reasoned but no `rawResponseItem/completed` reasoning item arrived, so #533 replay got no blob — a transport drop, or (confirmed live) a non-ZDR ChatGPT account where codex emits no raw reasoning items at all. Informational. (#597) |
| `codex:auth:login_started` | `{ type, loginId }` | OAuth or device-code flow initiated |
| `codex:auth:login_completed` | `{ loginId, success, planType?, error? }` | Login finished (success or failure) |
| `codex:auth:token_refresh` | `{ reason, previousAccountId? }` | Codex requested a fresh ChatGPT token |
| `codex:rate_limit:updated` | `{ limitId, primary, secondary?, planType, ... }` | New `account/rateLimits/updated` arrived |
| `codex:rate_limit:warning` | `{ segmentId, usedPercent, resetsAt? }` | A window crossed 80% used |
| `codex:thread:start` | `{ threadId, model, sessionId? }` | New Codex thread created |
| `codex:turn:start` | `{ threadId, turnId?, effort? }` | A turn was dispatched |
| `codex:turn:complete` | `{ threadId, turnId, durationMs, status }` | A turn finished |

(Encrypted-reasoning capture has no dedicated *success* event — it flows through the normal turn capture and shows up in the persisted assistant content, matching the openai-apikey path. The one diagnostic is `codex:rpc:reasoning_item_missing`, logged when the blob's carrier notification appears to have been dropped on the pipe — see Reasoning preservation and Transport reliability below, and issue #597.)

## Reasoning preservation across turns

Reasoning-effort-enabled turns produce an opaque `encrypted_content` blob per reasoning item that the Responses API will accept back as input on subsequent turns — that's what lets the model continue its chain-of-thought instead of re-deriving setup each round. The blob is **not** exposed on codex's sanitized `item/completed` stream (the `ReasoningThreadItem` view defines only `summary` and `content` text). It surfaces on a separate notification: **`rawResponseItem/completed`**.

Capture: the provider subscribes to `rawResponseItem/completed` per turn and stores items where `item.type === "reasoning"` and `encrypted_content` is non-null. Each captured item becomes a `reasoning` ContentPart on `assistantContent`. ZDR-off codex configurations don't forward the blob, in which case the item is dropped (persisting an empty shell would replay back as an invalid input item).

Unlike the inline image path (which falls back to reading the PNG off disk), this blob has **no fallback** — its sole carrier is the one `rawResponseItem/completed` line. The provider logs `codex:rpc:reasoning_item_missing` (once per session) when the model reasoned (summary deltas streamed) yet no raw reasoning item arrived. **A live test on a non-ZDR ChatGPT Plus account found this firing on every reasoning turn: codex emits no `rawResponseItem/completed` reasoning items there at all** — so encrypted-reasoning replay is effectively a **no-op for ChatGPT-account users** (the model re-derives its reasoning each turn — graceful, but #533 buys nothing on this path). A genuine *intermittent* transport drop instead surfaces as a `parse_failure` with a `methodGuess`. Whether raw/encrypted reasoning can be enabled for ChatGPT-account turns is a separate question worth its own investigation.

Replay: `messageToResponsesItems` emits any `reasoning` ContentPart as a Responses-API `reasoning` item at the **head** of the assistant turn (before message and function_call items, as the API requires).

The same encrypted-blob round-trip is what the `openai-apikey` / `openrouter` paths use directly against the Responses API. See issue #533 for the wider cross-provider context (Anthropic uses its own `thinking` + `redacted_thinking` blocks with `signature`; `custom` Chat-Completions endpoints have no equivalent contract).

## Wire gotchas (codex 0.130.0)

- **`requiresOpenaiAuth: true`** on `account/read` is misleading — it's true even when ChatGPT auth is fine. It really signals "needs an `sk-...` API key for non-ChatGPT models." Check `account.type === "chatgpt"` instead.
- **`sandbox`** on `thread/start` is kebab-case (`"read-only"`, `"workspace-write"`, `"danger-full-access"`), even though the corresponding object types use camelCase. The generated schema misleads.
- **`DynamicToolCallResponse`** requires both `success: boolean` AND `contentItems: [{ type: "inputText" | "inputImage", ... }]`. Both fields required, strict validation.
- **`dynamicTools`** is wire-supported via `thread/start` even though it's missing from the v0.130.0 generated schema. Could churn — pin codex versions and re-validate on bumps.
- **`modelContextWindow`** returned by `thread/tokenUsage/updated` reflects per-plan caps. GPT-5.5 reports 258,400 tokens on Plus, NOT the published 1.05M. Callers that care about an accurate window must read from this notification at runtime, not from `known-models.json`.

## Transport reliability

The JSON-RPC wire is newline-delimited JSON on the subprocess's **stdout**; multi-MB lines (chiefly inline base64 images) intermittently arrive corrupt and fail `JSON.parse`. Two mechanisms were ruled out empirically while investigating #597:

- **codex's tracing does not splice into stdout.** codex routes its `tracing` subscriber to **stderr** — verified by capturing the two streams separately and forcing `RUST_LOG=trace`: ~13 KB of ANSI records landed on stderr while stdout stayed 100% clean JSON. stderr is a separate fd; it cannot corrupt the stdout protocol pipe. (We now pipe + drain stderr to the engine log as `codex:subprocess:stderr` rather than `inherit`-ing it — both to surface codex's own diagnostics and to confirm what is/isn't on each stream. Only WARN/ERROR + non-tracing lines are logged: a live run at `RUST_LOG=info` emitted **121k** INFO span records in one turn, so the lower levels are filtered to keep the engine log usable. The drain itself must keep up regardless — that same 121k-line turn completed cleanly, confirming no pipe-buffer deadlock.)
- **Our read side is not lossy.** Node `readline` over the child stdout pipe delivers 3 MB lines interleaved with small notifications intact (60/60 whole, 0 parse failures in a stress probe).

By elimination the corruption originates inside **codex's own stdout writes** (a module printing directly to stdout, or one protocol write spliced into another). It predominantly hits the multi-MB image lines, which already recover via the disk fallback (`generated_images/<sessionId>/`) — confirmed in a live run where a 1.8 MB inline-image `item/completed` line parsed cleanly (logged as `large_line`) with no `parse_failure` and no disk recovery needed. Smaller non-image payloads are far less exposed; any large unparseable stdout line is logged as `codex:rpc:parse_failure` with a salvaged `methodGuess` so the dropped message type is attributable. (The encrypted-reasoning blob has no fallback, but a live test showed it never arrives on a non-ZDR ChatGPT account in the first place — see Reasoning preservation above.)

## Subprocess hygiene — disabled codex features

We spawn `codex app-server` with **`--disable plugins --disable shell_snapshot`** (`CODEX_LEAN_FLAGS` in `rpc.ts`; these are per-process `-c features.X=false` equivalents, **not** writes to `~/.codex/config.toml`). MV uses neither subsystem — it supplies its own tools via `dynamicTools` on `thread/start` and runs `sandbox: "read-only"` — and leaving them on is pure waste that surfaced as stderr noise once we started capturing it (#597):

- **`plugins`** makes codex re-read and re-validate every plugin manifest under `~/.codex` on **every turn** (a single malformed user plugin produced ~370 WARN lines in one live session) and fires a startup remote plugin-sync that 401s. Disabling it removes the work and the noise.
- **`shell_snapshot`** attempts a shell-environment snapshot per `thread/start` that isn't even supported on PowerShell (one WARN per thread).

Verified live: with both disabled, a full 9-turn session emitted **zero** plugin/shell/sync WARNs (vs ~370), every turn completed, and **`image_gen` still works** — it's a built-in skill, independent of the user-plugin system (a 1.58 MB portrait rendered and persisted as a valid PNG). Do **not** disable `image_generation`, `shell_tool` blindly, or other `stable` features without re-validating a render — only `plugins`/`shell_snapshot` were confirmed safe for MV's usage.

## Distribution

`@openai/codex` is a workspace dependency in `packages/engine/package.json`, so it's pulled in by `npm install` and bundled into `node_modules/` at build time. The Node SEA build vendors `node_modules/`, so shipped binaries get codex transparently — no auto-download UX needed for the common case. Developers running from source get it via `npm install`.

`CODEX_BIN` env var overrides the bundled binary if set — useful for local builds of codex or for testing version pinning.
