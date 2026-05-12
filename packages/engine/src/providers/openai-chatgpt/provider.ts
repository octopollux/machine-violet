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
import { getAccount, isChatGptAccount } from "./auth.js";
import { toUsageStatus, shouldWarn } from "./usage.js";
import { log } from "./log.js";
import type {
  InitializeResult, ThreadStartParams, ThreadStartResult,
  TurnStartParams, TurnCompletedNotification,
  AgentMessageDeltaNotification, ItemStartedNotification,
  ItemCompletedNotification, TokenUsageUpdatedNotification,
  RateLimitsUpdatedNotification, RateLimits,
  DynamicToolCallParams, DynamicToolCallResponse,
  DynamicToolSpec, ReasoningEffort,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface OpenAIChatGptProviderOptions {
  /** Stable session identifier for log correlation. */
  sessionId?: string;
  /** Working directory passed to thread/start. Cosmetic for our use case. */
  cwd?: string;
}

export function createOpenAIChatGptProvider(opts: OpenAIChatGptProviderOptions = {}): OpenAIChatGptProvider {
  return new OpenAIChatGptProvider(opts);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OpenAIChatGptProvider implements LLMProvider {
  readonly providerId = "openai-chatgpt";

  private rpc: CodexRpcClient | null = null;
  private startPromise: Promise<CodexRpcClient> | null = null;
  private latestRateLimits: RateLimits | null = null;
  private rateLimitListeners = new Set<(s: UsageStatus) => void>();
  private readonly sessionId?: string;
  private readonly cwd: string;

  constructor(opts: OpenAIChatGptProviderOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd ?? process.cwd();
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
        clientInfo: {
          name: "machine_violet",
          title: "Machine Violet",
          version: "1.0.1",
        },
        capabilities: { experimentalApi: true },
      });
      log.spawn({
        binaryPath: init.userAgent,
        version: init.userAgent,
        sessionId: this.sessionId,
      });
      client.notify("initialized", {});

      // Subscribe to rate-limit updates for the lifetime of the subprocess.
      client.onNotification<RateLimitsUpdatedNotification>(
        "account/rateLimits/updated",
        (params) => this.onRateLimitsUpdated(params.rateLimits),
      );

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
    const collected = new TurnCollector(onDelta);
    const unsubAgentDelta = client.onNotification<AgentMessageDeltaNotification>(
      "item/agentMessage/delta",
      (p) => collected.onAgentMessageDelta(p),
    );
    const unsubItemStarted = client.onNotification<ItemStartedNotification>(
      "item/started",
      (p) => collected.onItemStarted(p),
    );
    const unsubItemCompleted = client.onNotification<ItemCompletedNotification>(
      "item/completed",
      (p) => collected.onItemCompleted(p),
    );
    const unsubReasoning = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/textDelta",
      (p) => collected.onReasoningDelta(p),
    );
    const unsubReasoningSummary = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/summaryTextDelta",
      (p) => collected.onReasoningDelta(p),
    );
    const unsubTokenUsage = client.onNotification<TokenUsageUpdatedNotification>(
      "thread/tokenUsage/updated",
      (p) => collected.onTokenUsage(p),
    );

    // Tool dispatch: handle item/tool/call server requests by invoking
    // the caller's dispatchTool. Replies must use the strict Codex shape:
    //   { success: boolean, contentItems: [{type:"inputText", text}] }
    const unsubToolCall = client.onServerRequest<DynamicToolCallParams, DynamicToolCallResponse>(
      "item/tool/call",
      async (callParams) => {
        const call: NormalizedToolCall = {
          id: callParams.callId,
          name: callParams.tool,
          input: callParams.arguments,
        };
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
      },
    );

    // Turn completion future — resolves on `turn/completed` notification.
    let completionResolve: ((p: TurnCompletedNotification) => void) | null = null;
    const completion = new Promise<TurnCompletedNotification>((resolve) => {
      completionResolve = resolve;
    });
    const unsubCompleted = client.onNotification<TurnCompletedNotification>(
      "turn/completed",
      (p) => {
        if (completionResolve) {
          completionResolve(p);
          completionResolve = null;
        }
      },
    );

    try {
      const turnReq: TurnStartParams = {
        threadId,
        input: [{ type: "text", text: lastUserText }],
        ...(params.thinking?.effort
          ? { effort: mapEffort(params.thinking.effort) }
          : {}),
      };
      log.turnStart({ threadId, effort: turnReq.effort });
      const turnStart = await client.call<{ turn: { id: string } }>("turn/start", turnReq);
      const turnId = turnStart.turn.id;

      const completed = await completion;
      log.turnComplete({
        threadId,
        turnId,
        durationMs: completed.turn.durationMs,
        status: completed.turn.status,
      });

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
 * The trailing user message becomes `turn/start` input; everything before
 * it gets injected. If the last message isn't a user message (model just
 * emitted text and history hasn't been re-asked) we inject the entire
 * history and pass an empty turn input — Codex still runs a turn against
 * whatever context is present.
 */
function splitHistoryAndUserInput(messages: NormalizedMessage[]): SplitHistory {
  const items: unknown[] = [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      // The "last user message" must be a pure-text message (no tool_results,
      // no embedded structure) — otherwise we'd inject only part of the
      // semantic unit. Walk back if the trailing user message has tool_result
      // content; that's an inter-round message, not a fresh user turn.
      const m = messages[i];
      if (typeof m.content === "string") {
        lastUserIdx = i;
        break;
      }
      // Array content: pure text only counts as the trailing user message
      const onlyText = m.content.every((p) => p.type === "text");
      if (onlyText) {
        lastUserIdx = i;
        break;
      }
    }
  }

  const toInject = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx) : messages;
  for (const msg of toInject) {
    items.push(...messageToResponsesItems(msg));
  }

  let lastUserText = "";
  if (lastUserIdx >= 0) {
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

  return { historyToInject: items, lastUserText };
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
  if (typeof msg.content === "string") {
    return [{ type: "message", role: msg.role, content: msg.content }];
  }

  if (msg.role === "assistant") {
    const items: unknown[] = [];
    let pendingText = "";
    for (const part of msg.content) {
      if (part.type === "text") {
        pendingText += part.text;
      } else if (part.type === "tool_use") {
        if (pendingText) {
          items.push({ type: "message", role: "assistant", content: pendingText });
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
      items.push({ type: "message", role: "assistant", content: pendingText });
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
      items.push({ type: "message", role: "user", content: part.text });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Per-turn notification accumulator
// ---------------------------------------------------------------------------

class TurnCollector {
  private text = "";
  private reasoning: string[] = [];
  private toolCalls: NormalizedToolCall[] = [];
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
      // The assistantContent for history must be the FINAL committed text.
      if (this.assistantContent.length === 0 && this.text) {
        this.assistantContent.push({ type: "text", text: this.text });
      } else if (this.assistantContent.length > 0 && this.text) {
        const last = this.assistantContent[this.assistantContent.length - 1];
        if (last.type === "text") {
          last.text = this.text;
        }
      }
    }
  }

  onToolCall(call: NormalizedToolCall): void {
    this.toolCalls.push(call);
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
      toolCalls: this.toolCalls,
      usage,
      stopReason,
      thinkingText: this.reasoning.length > 0 ? this.reasoning.join("") : undefined,
      assistantContent: this.assistantContent,
    };
  }
}

// Re-export for tests / callers that need to recover from spawn failures.
export { CodexRpcError } from "./rpc.js";
