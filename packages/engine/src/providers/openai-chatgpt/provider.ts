/**
 * LLMProvider implementation backed by `codex app-server`.
 *
 * Per-instance lifecycle:
 *   1. Construction is sync and cheap — no subprocess spawned yet.
 *   2. First `chat()` / `stream()` call lazily spawns codex, runs
 *      `initialize`, validates a ChatGPT account is logged in.
 *   3. Each call creates a fresh Codex thread, injects the
 *      caller-supplied history (sans the last user message), kicks off
 *      a turn, runs an internal multi-round tool loop via
 *      `params.dispatchTool`, and returns the final ChatResult.
 *   4. `dispose()` shuts down the subprocess.
 *
 * Why fresh threads per chat() call: the bridge calls chat() with the
 * full normalized history each time. That history is the source of
 * truth — we own it, not Codex. Re-injecting per call keeps the model
 * exactly synced to our scribe/compaction view of the conversation.
 * (Codex's own thread persistence in `~/.codex/sessions/` becomes a
 * harmless second copy.) OpenAI's automatic prompt caching keeps the
 * cost of re-injection cheap on the wire.
 *
 * IMPORTANT: chat() requires `params.dispatchTool` whenever
 * `params.tools` is non-empty. Codex's `item/tool/call` server requests
 * arrive in-band over the JSON-RPC channel and must be replied to
 * synchronously to keep the turn alive. We dispatch the host's tool
 * handler in-process and reply with the result. Providers that don't
 * own tool dispatch (Anthropic, openai-apikey) surface tool calls back
 * to the bridge and let it re-issue chat() — that pattern doesn't
 * translate to Codex's protocol.
 */
import type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedToolCall, NormalizedTool,
  NormalizedUsage, ContentPart, StopReason, SystemBlock,
} from "../types.js";
import type { UsageStatus } from "@machine-violet/shared";
import { CodexRpcClient } from "./rpc.js";
import { getAccount, isChatGptAccount, pushChatGptAuthTokens } from "./auth.js";
import { toUsageStatus, shouldWarn } from "./usage.js";
import { log } from "./log.js";
import { getCodexClientInfo } from "./client-info.js";
import { refreshAccessToken } from "./oauth.js";
import { tokensFromOAuth } from "./token-store.js";
import type { ChatGptTokenStore, PersistedChatGptTokens } from "./token-store.js";
import type {
  InitializeResult, ThreadStartParams, ThreadStartResult,
  TurnStartParams, TurnCompletedNotification,
  AgentMessageDeltaNotification, ItemStartedNotification,
  ItemCompletedNotification, TokenUsageUpdatedNotification,
  RateLimitsUpdatedNotification, RateLimits,
  DynamicToolCallParams, DynamicToolCallResponse,
  DynamicToolSpec, ReasoningEffort,
  ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface OpenAIChatGptProviderOptions {
  /** Stable session identifier for log correlation. */
  sessionId?: string;
  /** Working directory passed to thread/start. Cosmetic for our use case. */
  cwd?: string;
  /**
   * Token store backing the chatgptAuthTokens flow. When provided, the
   * provider pushes tokens to codex at startup (refreshing first if
   * expired) and handles codex's `account/chatgptAuthTokens/refresh`
   * server requests by minting new tokens with the stored refresh_token.
   *
   * When absent, the provider falls back to whatever codex has cached in
   * `~/.codex/auth.json` — useful for the env-key codex_cli flow and for
   * tests. Sessions that exceed the access-token lifetime will fail
   * without a token store.
   */
  tokenStore?: ChatGptTokenStore;
}

export function createOpenAIChatGptProvider(opts: OpenAIChatGptProviderOptions = {}): OpenAIChatGptProvider {
  return new OpenAIChatGptProvider(opts);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Per-thread tool-call dispatcher registered by an in-flight `runTurn`.
 * The provider keeps a map keyed by `threadId` so concurrent `chat()`
 * calls (e.g. DM + theme-styler) each receive only their own
 * `item/tool/call` server requests. See {@link OpenAIChatGptProvider}
 * comments around the global `item/tool/call` registration for why we
 * route at the provider level rather than per-call.
 */
type ThreadToolDispatcher = (call: NormalizedToolCall) => Promise<DynamicToolCallResponse>;

export class OpenAIChatGptProvider implements LLMProvider {
  readonly providerId = "openai-chatgpt";

  private rpc: CodexRpcClient | null = null;
  private startPromise: Promise<CodexRpcClient> | null = null;
  private latestRateLimits: RateLimits | null = null;
  private rateLimitListeners = new Set<(s: UsageStatus) => void>();
  private readonly sessionId?: string;
  private readonly cwd: string;
  private readonly tokenStore?: ChatGptTokenStore;
  /**
   * Active per-thread tool dispatchers. Populated by `runTurn` at
   * subscribe time, cleared in its `finally`. The single
   * `item/tool/call` handler installed in `ensureStarted` looks up by
   * `threadId` from the incoming params so concurrent turns can't
   * cross-contaminate. `CodexRpcClient.onServerRequest` only supports
   * one handler per method (last write wins), so we must do the routing
   * ourselves.
   */
  private readonly toolDispatchers = new Map<string, ThreadToolDispatcher>();

  constructor(opts: OpenAIChatGptProviderOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd ?? process.cwd();
    this.tokenStore = opts.tokenStore;
  }

  // -----------------------------------------------------------------------
  // LLMProvider surface
  // -----------------------------------------------------------------------

  async chat(params: ChatParams): Promise<ChatResult> {
    return this.runTurn(params, undefined);
  }

  async stream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult> {
    return this.runTurn(params, onDelta);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const client = await this.ensureStarted();
      const acct = await getAccount(client);
      if (!acct.account) {
        return { status: "invalid", message: "Not signed in to ChatGPT — run the Sign in flow." };
      }
      if (!isChatGptAccount(acct)) {
        return { status: "invalid", message: `Logged in as ${acct.account.type}; expected chatgpt.` };
      }
      return { status: "valid", message: `Signed in as ${acct.account.email ?? "ChatGPT user"} (${acct.account.planType ?? "unknown plan"})` };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  getUsageStatus(): UsageStatus | null {
    if (!this.latestRateLimits) return null;
    return toUsageStatus(this.latestRateLimits);
  }

  subscribeUsage(cb: (status: UsageStatus) => void): () => void {
    this.rateLimitListeners.add(cb);
    return () => this.rateLimitListeners.delete(cb);
  }

  /** Shut down the subprocess. Called by session-manager at session end. */
  async dispose(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    this.rpc = null;
    this.startPromise = null;
    await rpc.stop();
  }

  // -----------------------------------------------------------------------
  // Subprocess lifecycle
  // -----------------------------------------------------------------------

  private async ensureStarted(): Promise<CodexRpcClient> {
    if (this.rpc) return this.rpc;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const client = new CodexRpcClient({ sessionId: this.sessionId });
      await client.start();

      const init = await client.call<InitializeResult>("initialize", {
        clientInfo: getCodexClientInfo(),
        capabilities: { experimentalApi: true },
      });
      // codex:subprocess:spawn is already logged by CodexRpcClient.startInternal
      // with the resolved binaryPath. Log a separate `initialized` event here
      // carrying the userAgent / codexHome / platform fields from the
      // handshake response — useful for debugging "which codex are we
      // actually talking to" without re-shadowing the spawn event.
      log.initialized({
        userAgent: init.userAgent,
        codexHome: init.codexHome,
        platformOs: init.platformOs,
        sessionId: this.sessionId,
      });
      client.notify("initialized", {});

      // Subscribe to rate-limit updates for the lifetime of the subprocess.
      client.onNotification<RateLimitsUpdatedNotification>(
        "account/rateLimits/updated",
        (params) => this.onRateLimitsUpdated(params.rateLimits),
      );

      // Register handler for codex's refresh server requests. Codex sends
      // this when the access_token returns 401 from the backend. We
      // exchange our stored refresh_token for a fresh access_token,
      // persist the new bundle, and reply with the new tokens.
      client.onServerRequest<ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse>(
        "account/chatgptAuthTokens/refresh",
        async (params) => this.handleRefreshRequest(params),
      );

      // Single global handler for `item/tool/call`. Routes to the active
      // per-thread dispatcher in `toolDispatchers`. Registering once at
      // the provider level (rather than once per `runTurn`) is required
      // because `onServerRequest` is single-handler-per-method: a second
      // `runTurn` registration would silently overwrite the first, and
      // the first turn's tool calls would land in the wrong dispatcher.
      // If no dispatcher is registered for a `threadId` (turn already
      // finished, race condition, or codex bug), reply with an error
      // result rather than throwing — the latter would deadlock the
      // turn waiting for a tool reply that never comes.
      client.onServerRequest<DynamicToolCallParams, DynamicToolCallResponse>(
        "item/tool/call",
        async (callParams) => {
          const dispatcher = this.toolDispatchers.get(callParams.threadId);
          if (!dispatcher) {
            return {
              success: false,
              contentItems: [{
                type: "inputText",
                text: `no active tool dispatcher for thread ${callParams.threadId}`,
              }],
            };
          }
          return dispatcher({
            id: callParams.callId,
            name: callParams.tool,
            input: callParams.arguments,
          });
        },
      );

      // If we have stored tokens, hand them to codex now (refreshing first
      // when they're already expired or about to be). Without this codex
      // would either fall back to whatever's in ~/.codex/auth.json or hit
      // an unauthenticated state.
      if (this.tokenStore) {
        await this.pushInitialTokens(client);
      }

      this.rpc = client;
      return client;
    })();

    try {
      return await this.startPromise;
    } catch (err) {
      // Clear so subsequent calls retry from scratch instead of latching onto
      // a rejected promise forever.
      this.startPromise = null;
      this.rpc = null;
      throw err;
    }
  }

  /**
   * Refresh-if-needed, then push the stored tokens into codex via
   * `account/login/start type:"chatgptAuthTokens"`. Called from
   * ensureStarted when a token store is configured.
   */
  private async pushInitialTokens(client: CodexRpcClient): Promise<void> {
    const store = this.tokenStore;
    if (!store) return;
    let tokens = store.load();
    if (!tokens) {
      // No stored tokens — likely an old connection record from before the
      // chatgptAuthTokens flow existed. Let codex fall back to auth.json
      // (or fail at the first call) rather than blocking startup.
      return;
    }
    // 60 seconds of slack so we don't hand codex a token that expires
    // mid-turn. Codex's refresh request handles longer-running drift.
    if (tokens.expiresAtMs <= Date.now() + 60_000) {
      tokens = await this.refreshAndStore(tokens.refreshToken);
      if (!tokens) {
        throw new Error("ChatGPT token refresh failed and no valid token available; please sign in again.");
      }
    }
    await pushChatGptAuthTokens(client, {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
  }

  /**
   * Handle codex's `account/chatgptAuthTokens/refresh` server request:
   * use the stored refresh_token to mint a new access_token, persist it,
   * and return the new bundle to codex.
   */
  private async handleRefreshRequest(
    _params: ChatgptAuthTokensRefreshParams,
  ): Promise<ChatgptAuthTokensRefreshResponse> {
    const store = this.tokenStore;
    if (!store) {
      throw new Error("Cannot refresh ChatGPT tokens: no token store configured");
    }
    const current = store.load();
    if (!current) {
      throw new Error("Cannot refresh ChatGPT tokens: no stored tokens");
    }
    log.tokenRefresh({ reason: _params.reason, previousAccountId: _params.previousAccountId ?? undefined });
    const fresh = await this.refreshAndStore(current.refreshToken);
    if (!fresh) {
      throw new Error("ChatGPT refresh_token rejected by OpenAI; please sign in again.");
    }
    return {
      accessToken: fresh.accessToken,
      chatgptAccountId: fresh.chatgptAccountId,
      chatgptPlanType: fresh.chatgptPlanType ?? null,
    };
  }

  /** Exchange a refresh_token for a fresh bundle and persist via tokenStore. */
  private async refreshAndStore(refreshToken: string): Promise<PersistedChatGptTokens | null> {
    const store = this.tokenStore;
    if (!store) return null;
    const oauth = await refreshAccessToken(refreshToken);
    const existing = store.load();
    const fresh = tokensFromOAuth(oauth, existing?.chatgptAccountId);
    if (!fresh) return null;
    store.save(fresh);
    return fresh;
  }

  private onRateLimitsUpdated(limits: RateLimits): void {
    this.latestRateLimits = limits;
    log.rateLimitUpdated({ ...limits });
    if (shouldWarn(limits)) {
      if (limits.primary.usedPercent >= 80) {
        log.rateLimitWarning({
          segmentId: "primary",
          usedPercent: limits.primary.usedPercent,
          resetsAt: limits.primary.resetsAt,
        });
      }
      if (limits.secondary && limits.secondary.usedPercent >= 80) {
        log.rateLimitWarning({
          segmentId: "secondary",
          usedPercent: limits.secondary.usedPercent,
          resetsAt: limits.secondary.resetsAt,
        });
      }
    }
    if (this.rateLimitListeners.size > 0) {
      const status = toUsageStatus(limits);
      for (const cb of this.rateLimitListeners) cb(status);
    }
  }

  // -----------------------------------------------------------------------
  // Turn execution
  // -----------------------------------------------------------------------

  private async runTurn(params: ChatParams, onDelta?: (text: string) => void): Promise<ChatResult> {
    if (params.tools?.length && !params.dispatchTool) {
      throw new Error(
        "openai-chatgpt provider requires params.dispatchTool when params.tools is non-empty " +
        "(Codex tool calls arrive as in-band server requests that must be answered synchronously).",
      );
    }

    const client = await this.ensureStarted();

    // Validate auth before opening a thread — fail fast with a clean error.
    const acct = await getAccount(client);
    if (!isChatGptAccount(acct)) {
      throw new Error(
        "openai-chatgpt connection has no active ChatGPT login. " +
        "Run 'Sign in with ChatGPT' from the Connections menu.",
      );
    }

    // Split history: everything before the final user message goes via
    // thread/inject_items; the final user message becomes turn input.
    // If there is no trailing user message (unusual — caller misuse),
    // we still have to feed turn/start something, so synthesize an empty
    // text input rather than crash.
    const { historyToInject, lastUserText } = splitHistoryAndUserInput(params.messages);

    // Build the developer instructions from systemPrompt blocks.
    const developerInstructions = systemPromptToString(params.systemPrompt);

    // Convert tools to DynamicToolSpec.
    const dynamicTools: DynamicToolSpec[] | undefined = params.tools?.length
      ? params.tools.map(toolToDynamicSpec)
      : undefined;

    const startParams: ThreadStartParams = {
      model: params.model,
      developerInstructions,
      ...(dynamicTools ? { dynamicTools } : {}),
      cwd: this.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
    };

    const thread = await client.call<ThreadStartResult>("thread/start", startParams);
    const threadId = thread.thread.id;
    log.threadStart({ threadId, model: params.model, sessionId: this.sessionId });

    // Inject prior history if any.
    if (historyToInject.length > 0) {
      await client.call("thread/inject_items", {
        threadId,
        items: historyToInject,
      });
    }

    // Subscribe to per-turn notifications BEFORE issuing turn/start.
    //
    // CRITICAL: every handler must filter by `threadId`. The codex
    // subprocess is shared across all concurrent `chat()` calls on this
    // provider — e.g. DM (gpt-5.5) and theme-styler (gpt-5.4-mini) run
    // simultaneously during a normal turn. The RPC client broadcasts each
    // notification to every subscriber, so without this guard each
    // TurnCollector would harvest deltas, tool calls, and completion
    // events from the *other* turn, producing duplicated/spliced
    // assistant output and resolving `completion` on the wrong turn.
    const collected = new TurnCollector(onDelta);
    const forThisThread = (p: { threadId: string }): boolean => p.threadId === threadId;
    const unsubAgentDelta = client.onNotification<AgentMessageDeltaNotification>(
      "item/agentMessage/delta",
      (p) => { if (forThisThread(p)) collected.onAgentMessageDelta(p); },
    );
    const unsubItemStarted = client.onNotification<ItemStartedNotification>(
      "item/started",
      (p) => { if (forThisThread(p)) collected.onItemStarted(p); },
    );
    const unsubItemCompleted = client.onNotification<ItemCompletedNotification>(
      "item/completed",
      (p) => { if (forThisThread(p)) collected.onItemCompleted(p); },
    );
    const unsubReasoning = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/textDelta",
      (p) => { if (forThisThread(p)) collected.onReasoningDelta(p); },
    );
    const unsubReasoningSummary = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/summaryTextDelta",
      (p) => { if (forThisThread(p)) collected.onReasoningDelta(p); },
    );
    const unsubTokenUsage = client.onNotification<TokenUsageUpdatedNotification>(
      "thread/tokenUsage/updated",
      (p) => { if (forThisThread(p)) collected.onTokenUsage(p); },
    );

    // Tool dispatch: install a per-thread dispatcher into the provider's
    // routing map. The global `item/tool/call` handler registered in
    // `ensureStarted` looks us up by `threadId` and forwards. Replies
    // must use the strict Codex shape:
    //   { success: boolean, contentItems: [{type:"inputText", text}] }
    const dispatchForThread: ThreadToolDispatcher = async (call) => {
      collected.onToolCall(call);
      const dispatcher = params.dispatchTool;
      if (!dispatcher) {
        // Should be unreachable — we guarded above when tools is set.
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "no dispatchTool configured" }],
        };
      }
      try {
        const result = await dispatcher(call);
        return {
          success: !result.isError,
          contentItems: [{ type: "inputText", text: result.content }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          contentItems: [{ type: "inputText", text: `tool dispatch failed: ${msg}` }],
        };
      }
    };
    this.toolDispatchers.set(threadId, dispatchForThread);
    const unsubToolCall = (): void => { this.toolDispatchers.delete(threadId); };

    // Turn completion future — resolves on `turn/completed` notification
    // FOR THIS THREAD ONLY (see thread-filter rationale above).
    let completionResolve: ((p: TurnCompletedNotification) => void) | null = null;
    const completion = new Promise<TurnCompletedNotification>((resolve) => {
      completionResolve = resolve;
    });
    const unsubCompleted = client.onNotification<TurnCompletedNotification>(
      "turn/completed",
      (p) => {
        if (!forThisThread(p)) return;
        if (completionResolve) {
          completionResolve(p);
          completionResolve = null;
        }
      },
    );

    try {
      // Empty `lastUserText` means we're resuming from history alone
      // (e.g. after resolveChoice pushed a tool_result for a
      // suspending-tool flow like present_choices). Counter-intuitively
      // codex no-ops `turn/start` when `input: []` — the RPC returns a
      // turn id but no task ever starts, so notifications stop arriving
      // and the call hangs forever. We must hand it a non-empty input.
      //
      // We can't avoid this by skipping the function_call_output from
      // injection either: the Responses API requires `function_call` to
      // be paired with `function_call_output`, so the items must stay.
      // Instead we pass a tiny continuation cue. The model treats it as
      // a benign user prompt and generates its next response from the
      // injected tool result.
      const turnInput: TurnStartParams["input"] = lastUserText
        ? [{ type: "text", text: lastUserText }]
        : [{ type: "text", text: "(continue)" }];
      // Request detailed reasoning summaries whenever we're asking for any
      // reasoning effort. Without this, codex defaults to summary="none" for
      // chatgpt-account flows and our thinkingText never gets populated even
      // though reasoning tokens are billed — see protocol.ts:TurnStartParams.
      const turnReq: TurnStartParams = {
        threadId,
        input: turnInput,
        ...(params.thinking?.effort
          ? {
              effort: mapEffort(params.thinking.effort),
              summary: "detailed",
            }
          : {}),
      };
      log.turnStart({ threadId, effort: turnReq.effort });
      const turnStart = await client.call<{ turn: { id: string } }>("turn/start", turnReq);
      const turnId = turnStart.turn.id;

      const completed = await completion;
      const errorMessage = completed.turn.error?.message ?? null;
      log.turnComplete({
        threadId,
        turnId,
        durationMs: completed.turn.durationMs,
        status: completed.turn.status,
        error: errorMessage,
      });

      // A failed Codex turn is a system-level failure (model-not-found,
      // auth, rate limit, tools schema mismatch, etc), not a content
      // refusal. Surface the reason instead of returning empty text —
      // callers like setup-conversation don't check stopReason and would
      // otherwise render nothing.
      if (completed.turn.status === "failed") {
        throw new CodexTurnFailedError(errorMessage ?? "(no error message from codex)", turnId);
      }

      return collected.toChatResult(completed);
    } finally {
      unsubAgentDelta();
      unsubItemStarted();
      unsubItemCompleted();
      unsubReasoning();
      unsubReasoningSummary();
      unsubTokenUsage();
      unsubToolCall();
      unsubCompleted();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function systemPromptToString(systemPrompt: string | SystemBlock[]): string {
  if (typeof systemPrompt === "string") return systemPrompt;
  return systemPrompt.map((b) => b.text).join("\n\n");
}

function toolToDynamicSpec(tool: NormalizedTool): DynamicToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function mapEffort(effort: "low" | "medium" | "high" | "max" | null): ReasoningEffort {
  if (effort === "max") return "xhigh";
  if (effort === null) return "minimal";
  return effort;
}

interface SplitHistory {
  historyToInject: unknown[];
  lastUserText: string;
}

/**
 * Convert NormalizedMessage[] → Responses-API items + extract last user text.
 *
 * Codex `thread/inject_items` accepts raw Responses-API items. Assistant
 * tool_use blocks become `function_call` items; user tool_result blocks
 * become `function_call_output` items; plain text becomes `message` items.
 *
 * Turn input strategy depends on what the trailing message looks like:
 *
 * - **Trailing user message is pure text** — that's a fresh user turn.
 *   Use its text as `turn/start` input; inject everything before it as
 *   history.
 * - **Trailing user message contains tool_result blocks** — we're
 *   resuming after an inter-round tool dispatch (e.g. setup's
 *   `present_choices` → player picked → resolveChoice pushes
 *   `tool_result` and re-enters the loop). Inject the ENTIRE history,
 *   including the tool_result message, and pass empty turn input. Codex
 *   reads the function_call_output items and continues the conversation
 *   without needing a new user message.
 * - **Trailing message is assistant** (model emitted text and we haven't
 *   asked again) — same as the tool_result case: inject everything,
 *   empty input.
 *
 * Empty turn input is supported by codex — it runs a turn against
 * whatever context is present in the thread.
 */
function splitHistoryAndUserInput(messages: NormalizedMessage[]): SplitHistory {
  // Find the LAST user message (don't walk past it — its shape decides
  // the turn-input strategy).
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Is that message a fresh user turn (pure text), or inter-round tool
  // plumbing? Pure text → use as turn input; otherwise → inject as history.
  let useAsTurnInput = false;
  if (lastUserIdx >= 0) {
    const m = messages[lastUserIdx];
    useAsTurnInput = typeof m.content === "string"
      || m.content.every((p) => p.type === "text");
  }

  const items: unknown[] = [];
  const toInject = useAsTurnInput ? messages.slice(0, lastUserIdx) : messages;
  for (const msg of toInject) {
    items.push(...messageToResponsesItems(msg));
  }
  const interleaved = interleaveCallsAndOutputs(items);

  let lastUserText = "";
  if (useAsTurnInput && lastUserIdx >= 0) {
    const m = messages[lastUserIdx];
    if (typeof m.content === "string") {
      lastUserText = m.content;
    } else {
      lastUserText = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
    }
  }

  return { historyToInject: interleaved, lastUserText };
}

/**
 * Reorder a flat Responses-API item list so each `function_call` is
 * immediately followed by its matching `function_call_output`.
 *
 * Why this exists: our normalized history groups all tool_use blocks
 * under one assistant message and all tool_result blocks under the next
 * user message. Naive conversion yields
 *   function_call(A), function_call(B), function_call_output(A), function_call_output(B)
 * which the Responses API rejects — it requires strict immediate pairing.
 *
 * Outputs that match nothing are dropped (orphan results indicate
 * upstream state corruption; passing them through would just provoke a
 * different API error). Calls that match nothing pass through as-is and
 * will trigger a "missing output" error from codex/OpenAI — preferable
 * to a silent hang.
 */
function interleaveCallsAndOutputs(items: unknown[]): unknown[] {
  interface Item { type?: string; call_id?: string }
  // Index every function_call_output by its call_id, and remember which
  // index it sits at so we can skip it during the main pass.
  const outputByCallId = new Map<string, unknown>();
  const consumedOutputIndices = new Set<number>();
  items.forEach((raw, idx) => {
    const it = raw as Item;
    if (it.type === "function_call_output" && typeof it.call_id === "string") {
      outputByCallId.set(it.call_id, raw);
      consumedOutputIndices.add(idx);
    }
  });

  const result: unknown[] = [];
  const placedCallIds = new Set<string>();
  items.forEach((raw, idx) => {
    if (consumedOutputIndices.has(idx)) return;
    const it = raw as Item;
    result.push(raw);
    if (it.type === "function_call" && typeof it.call_id === "string") {
      const output = outputByCallId.get(it.call_id);
      if (output && !placedCallIds.has(it.call_id)) {
        result.push(output);
        placedCallIds.add(it.call_id);
      }
    }
  });
  return result;
}

/**
 * Convert one normalized message to one or more Responses-API items.
 *
 * Mirrors the converter in providers/openai.ts (toResponsesInput) but is
 * duplicated here rather than exported to keep cross-module coupling
 * minimal — the openai.ts version is keyed to a slightly different
 * SystemBlock convention. If they diverge meaningfully in the future,
 * extract to providers/openai-shared.ts.
 */
function messageToResponsesItems(msg: NormalizedMessage): unknown[] {
  // Codex's Responses-API deserializer is stricter than the OpenAI SDK:
  // `message.content` MUST be a sequence of typed content parts, never a
  // bare string. User text → `input_text`, assistant text → `output_text`.
  // Sending a raw string yields:
  //   "items[0] is not a valid response item: invalid type: string ...,
  //    expected a sequence"
  // and aborts the turn. Always wrap.
  const userPart = (text: string) => ({ type: "input_text", text });
  const asstPart = (text: string) => ({ type: "output_text", text });

  if (typeof msg.content === "string") {
    const part = msg.role === "user" ? userPart(msg.content) : asstPart(msg.content);
    return [{ type: "message", role: msg.role, content: [part] }];
  }

  if (msg.role === "assistant") {
    const items: unknown[] = [];
    let pendingText = "";
    for (const part of msg.content) {
      if (part.type === "text") {
        pendingText += part.text;
      } else if (part.type === "tool_use") {
        if (pendingText) {
          items.push({ type: "message", role: "assistant", content: [asstPart(pendingText)] });
          pendingText = "";
        }
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      }
      // Skip thinking blocks — never sent back.
    }
    if (pendingText) {
      items.push({ type: "message", role: "assistant", content: [asstPart(pendingText)] });
    }
    return items;
  }

  // user message with array content
  const items: unknown[] = [];
  for (const part of msg.content) {
    if (part.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: part.tool_use_id,
        output: part.content,
      });
    } else if (part.type === "text") {
      items.push({ type: "message", role: "user", content: [userPart(part.text)] });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Per-turn notification accumulator
// ---------------------------------------------------------------------------

// Exported for unit tests — production callers go through OpenAIChatGptProvider.
export class TurnCollector {
  private text = "";
  private reasoning: string[] = [];
  private assistantContent: ContentPart[] = [];
  private latestUsage: TokenUsageUpdatedNotification["tokenUsage"] | null = null;

  constructor(private readonly onDelta?: (text: string) => void) {}

  onAgentMessageDelta(params: AgentMessageDeltaNotification): void {
    this.text += params.delta;
    this.onDelta?.(params.delta);
  }

  onReasoningDelta(params: AgentMessageDeltaNotification): void {
    this.reasoning.push(params.delta);
  }

  onItemStarted(_params: ItemStartedNotification): void {
    // Currently unused — tool-call items also fire as server requests
    // (handled separately) so we don't need to track them here.
  }

  onItemCompleted(params: ItemCompletedNotification): void {
    if (params.item.type === "agentMessage" && params.item.text) {
      // Last-text-wins: if we accumulated streaming deltas, the completed
      // item's full text supersedes them only if our accumulation is empty.
      // Otherwise the streaming sum is canonical.
      if (!this.text) this.text = params.item.text;
      if (!this.text) return;
      // The assistantContent for history must include the FINAL committed
      // text. Three cases (Copilot-flagged on #481 — case 3 used to drop
      // the prose entirely):
      //   1. Empty buffer → push the text block.
      //   2. Last block is text → update it in place (streaming case).
      //   3. Last block is a tool_use → append a new text block. Codex
      //      can complete an agentMessage AFTER a tool_use item in the
      //      same turn, and without this branch the assistant prose
      //      vanishes from downstream history.
      const last = this.assistantContent[this.assistantContent.length - 1];
      if (!last) {
        this.assistantContent.push({ type: "text", text: this.text });
      } else if (last.type === "text") {
        last.text = this.text;
      } else {
        this.assistantContent.push({ type: "text", text: this.text });
      }
    }
  }

  onToolCall(call: NormalizedToolCall): void {
    // Codex owns tool dispatch end-to-end (the model gets the tool_result
    // in-band during the same turn), so we deliberately do NOT surface
    // calls back through ChatResult.toolCalls — the bridge would otherwise
    // re-dispatch them after chat() returns, running every write_entity /
    // scribe write twice. assistantContent keeps the tool_use block so the
    // returned conversation history still reflects what the model did.
    this.assistantContent.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }

  onTokenUsage(params: TokenUsageUpdatedNotification): void {
    this.latestUsage = params.tokenUsage;
  }

  toChatResult(completed: TurnCompletedNotification): ChatResult {
    const stopReason: StopReason =
      completed.turn.status === "completed" ? "end"
      : completed.turn.status === "interrupted" ? "end"
      : completed.turn.status === "failed" ? "refusal"
      : "end";

    const usage: NormalizedUsage = this.latestUsage
      ? {
          inputTokens: this.latestUsage.last.inputTokens,
          outputTokens: this.latestUsage.last.outputTokens,
          cacheReadTokens: this.latestUsage.last.cachedInputTokens,
          cacheCreationTokens: 0,
          reasoningTokens: this.latestUsage.last.reasoningOutputTokens,
        }
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };

    // Ensure a trailing text block exists in assistantContent so downstream
    // history reconstruction sees the final assistant message even if
    // item/completed never arrived (shouldn't happen, defensive).
    if (this.text && this.assistantContent.length === 0) {
      this.assistantContent.push({ type: "text", text: this.text });
    }

    return {
      text: this.text,
      // Always empty — see onToolCall. Tool calls were dispatched in-band
      // during the turn, so the bridge must not see them here.
      toolCalls: [],
      usage,
      stopReason,
      thinkingText: this.reasoning.length > 0 ? this.reasoning.join("") : undefined,
      assistantContent: this.assistantContent,
    };
  }
}

// Re-export for tests / callers that need to recover from spawn failures.
export { CodexRpcError } from "./rpc.js";

/**
 * Structured classification of a failed codex turn. Decided at the codex
 * boundary so callers route on the `kind` (a stable enum) instead of
 * pattern-matching the human-readable `codexMessage` (which drifts with
 * upstream wording changes). New kinds may be added; consumers using a
 * switch should treat unknown values as `"unknown"`.
 *
 *  - `auth_expired` — the refresh_token was rejected, or codex reported
 *    an OAuth/auth failure. Player needs to re-sign-in.
 *  - `model_not_found` — codex (or its backend) couldn't find the
 *    requested model name. Player needs to pick a different model.
 *  - `tools_schema_mismatch` — codex rejected the tool definitions at
 *    thread start (usually a protocol-version drift between us and codex).
 *  - `unknown` — anything else. Treated as session-fatal by the error
 *    router; better to surface the real codex message and let the player
 *    decide than to claim it's recoverable when it isn't.
 */
export type CodexFailureKind = "auth_expired" | "model_not_found" | "tools_schema_mismatch" | "unknown";

/**
 * Classify a raw codex error message into a {@link CodexFailureKind}.
 *
 * Pattern matches are deliberately broad — codex (and the OpenAI backend
 * it speaks to) phrases the same condition multiple ways, so we look for
 * stable substrings rather than exact strings. When in doubt, return
 * `"unknown"` and let the human-readable message speak for itself.
 *
 * Exported for unit tests; production callers see only the
 * `CodexTurnFailedError.kind` field populated from this function.
 */
export function classifyCodexFailure(message: string): CodexFailureKind {
  const m = message.toLowerCase();
  // Auth: the canonical case from issue #529 is a refresh-token rejection
  // ("Your access token could not be refreshed because your refresh token
  // was already used. Please log out and sign in again."). Also catch the
  // bare 401 / unauthorized / token-expired phrasings codex uses when the
  // access_token is rejected without a recoverable path.
  if (
    /refresh.*token/.test(m)
    || /access[_ ]token.*(expired|invalid|rejected)/.test(m)
    || /unauthorized/.test(m)
    || /\b401\b/.test(m)
    || /log\s*out.*sign\s*in/.test(m)
  ) {
    return "auth_expired";
  }
  // Model not found: codex / OpenAI both phrase this as "model … not found"
  // or "unknown model" or "does not exist". The 404 status sometimes leaks
  // into the message string too.
  if (
    /model.*not\s*found/.test(m)
    || /unknown\s*model/.test(m)
    || /model.*(does\s*not\s*exist|doesn'?t\s*exist)/.test(m)
    || /no\s*such\s*model/.test(m)
  ) {
    return "model_not_found";
  }
  // Tools schema mismatch — codex rejects the dynamic-tool definitions
  // before turn/start completes. Recognisable by "tool" + a validation /
  // schema verb.
  if (
    /tool.*schema/.test(m)
    || /tool.*(invalid|rejected|malformed)/.test(m)
    || /invalid.*tool/.test(m)
  ) {
    return "tools_schema_mismatch";
  }
  return "unknown";
}

/**
 * Thrown when a Codex turn returns `status: "failed"`. Carries the
 * `turn.error.message` Codex reported alongside the failure — without it
 * callers see only `status: "failed"` in the engine log and can't tell why
 * (model not found, auth expired, rate limit, tools schema mismatch, …).
 *
 * The `kind` field is the *stable* classification consumers should branch
 * on. `codexMessage` is the verbatim string codex returned and is intended
 * for user-visible surfacing only — never pattern-match it in code.
 *
 * Why throw instead of returning an empty ChatResult? A failed turn is a
 * system-level error, not a content refusal. The previous behavior mapped
 * `failed → stopReason: "refusal"` with empty text, which callers like
 * setup-conversation (which calls `provider.chat()` directly without an
 * agent-loop wrapper) silently treated as a no-op, rendering nothing to
 * the player. Throwing forces callers to either handle the failure
 * explicitly or surface it as an error event.
 */
export class CodexTurnFailedError extends Error {
  public readonly kind: CodexFailureKind;
  constructor(
    public readonly codexMessage: string,
    public readonly turnId: string,
  ) {
    super(`Codex turn ${turnId} failed: ${codexMessage}`);
    this.name = "CodexTurnFailedError";
    this.kind = classifyCodexFailure(codexMessage);
  }
}
