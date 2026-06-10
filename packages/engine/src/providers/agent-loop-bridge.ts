/**
 * Bridge between the provider abstraction and the existing agent loop.
 *
 * This module provides `runProviderLoop` — a provider-agnostic version
 * of `runAgentLoop` that uses `LLMProvider` instead of the Anthropic SDK.
 * The result is in normalized types, not Anthropic-specific types.
 *
 * The existing `runAgentLoop` continues to work for Anthropic-only paths.
 * Callers migrate to `runProviderLoop` incrementally.
 */
import type {
  LLMProvider, ChatParams, ChatResult, DispatchToolFn,
  NormalizedMessage, NormalizedTool,
  ContentPart, NormalizedUsage, SystemBlock, ThinkingConfig,
  CacheHint,
} from "./types.js";
import type { ToolResult } from "../agents/tool-registry.js";
import type { TuiCommand } from "../agents/agent-loop.js";
import {
  extractStatus, RETRYABLE_STATUS, retryDelay, sleep,
} from "../utils/retry.js";

/**
 * TUI command types that require engine-side processing (scene transitions,
 * file I/O, etc.) and must be deferred until after the agent loop finishes.
 * Everything else is a visual-only update broadcast to the client immediately.
 *
 * Defined here (not in agent-loop.ts) to avoid a runtime circular dependency
 * (agent-loop → agent-loop-bridge → agent-loop).
 */
const DEFERRED_TUI_TYPES = new Set([
  "scene_transition",
  "session_end",
  "rollback",
  "scribe",
  "dm_notes",
  "promote_character",
  // `present_choices` is visual-only (modal), but we defer its broadcast
  // so the choice modal never appears before the DM's prose. Models that
  // interleave text and tool_use (Anthropic) emit prose first naturally,
  // but GPT-5.5 via codex emits *all* tool calls before any prose, so
  // an immediate broadcast pops the modal up 5–15s before the player can
  // read what just happened. Deferring keeps "read narrative → pick" as
  // the consistent UX across providers. game-engine.ts re-broadcasts
  // queued present_choices commands via onTuiCommand after the loop.
  "present_choices",
]);
import { normalizeTurn, type CapturedToolResult } from "./normalize-turn.js";
import { dumpContext, dumpThinking } from "../config/context-dump.js";
import { logEvent } from "../context/engine-log.js";
import { withSpan, setSpanAttrs, captureContext, runInContext, type TraceContext } from "../context/trace.js";
import { ContentRefusalError } from "@machine-violet/shared/types/errors.js";
import { getEffortConfig } from "../config/models.js";
import type { EffortLevel } from "../config/models.js";
import { getKnownModel } from "../config/model-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => ToolResult | Promise<ToolResult>;

export interface ProviderLoopConfig {
  name: string;
  model: string;
  maxTokens: number;
  maxToolRounds?: number;
  effort?: EffortLevel | null;
  stream?: boolean;
  tools?: NormalizedTool[];
  toolHandler?: ToolHandler;
  cacheHints?: CacheHint[];
  tuiToolNames?: Set<string>;
  /** Called immediately when a non-deferred TUI command is extracted. */
  onTuiCommand?: (cmd: TuiCommand) => void;
  terseSuffix?: boolean;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, result: ToolResult) => void;
  onComplete?: (usage: NormalizedUsage) => void;
  onError?: (error: Error) => void;
  /** Called when a retryable API error triggers a backoff wait. */
  onRetry?: (status: number, delayMs: number) => void;
  /**
   * Called when a streaming attempt fails mid-stream and is about to be
   * retried. Fires only if `onTextDelta` was actually invoked during the
   * failed attempt (i.e., partial output may have leaked to consumers).
   * Fires before the backoff sleep, so consumers can publish a corrective
   * snapshot before the retry begins streaming again.
   */
  onRollback?: () => void;
  /** Max retries after the initial attempt. Defaults to Infinity — the spec
   *  promises indefinite retry on transient errors (status 0, 429, 500, 502,
   *  503, 529) and the user-facing modal says "auto-resume on reconnect", so
   *  giving up after a fixed cap silently strands the player. Tests override
   *  this with a small number to exercise the exhaustion path. */
  maxRetries?: number;
}

export interface ProviderLoopResult {
  text: string;
  tuiCommands: TuiCommand[];
  usage: NormalizedUsage;
  truncated: boolean;
  /**
   * The complete turn as one canonical, self-consistent message sequence,
   * identical in shape across providers (see `normalizeTurn`): tool
   * interactions are `assistant([…, tool_use*])` → `user([tool_result*])`
   * pairs, every `tool_use` has a matching `tool_result`, and the turn ends
   * with an `assistant` message whose content is the narration. The engine
   * stores this verbatim — it must never re-inspect the shape.
   */
  turnMessages: NormalizedMessage[];
}

// ---------------------------------------------------------------------------
// Per-call dispatch (shared by the bridge's loop and the dispatchTool closure
// passed to providers that own tool dispatch internally — e.g. openai-chatgpt).
// ---------------------------------------------------------------------------

interface DispatchedToolCall {
  /** Content to feed back to the model — either as a tool_result block (bridge loop) or as a Codex DynamicToolCallResponse contentItem. */
  content: string;
  isError: boolean;
}

/**
 * Run a single tool dispatch. Wraps `config.toolHandler`, surfaces TUI
 * commands via the `onTui` callback, and applies the deferred-TUI sentinel
 * to the returned content. Errors are caught and returned as
 * `{ isError: true }` results so a single throw doesn't abort the caller.
 *
 * Why the sentinel: deferred TUI tools (scribe, scene_transition, dm_notes,
 * promote_character, session_end) execute server-side after the agent
 * loop returns, so their tool_result is just a queue confirmation. Without
 * an explicit signal that the prior narrative was already delivered, the
 * model treats the generic ack ambiguously and frequently re-narrates in
 * the next round — verbatim or lightly regenerated, but always wasting an
 * inference call. Append a uniform signal so tool handlers don't each
 * have to remember to include it. Skipped on errors so failure messages
 * aren't diluted, and on non-deferred TUI tools where the model often
 * continues narrating mid-turn legitimately.
 */
async function dispatchToolCall(
  tc: { id: string; name: string; input: Record<string, unknown> },
  config: ProviderLoopConfig,
  tuiToolNames: Set<string>,
  onTui: (cmd: TuiCommand) => void,
): Promise<DispatchedToolCall> {
  // One span per tool call. Parallel calls in a round (Promise.all) become
  // sibling bars with overlapping [t0,t1]; async tools that spawn a subagent
  // (search_campaign, resolve_turn) carry that subagent's agent span as a
  // child via the ALS context. `failed` (not the span-level `isError`, which
  // is reserved for *thrown* errors) flags a handled error-result so the
  // flame chart can colour it without conflating the two.
  return withSpan(
    { kind: tc.name === "generate_image" ? "image_gen" : "tool", name: tc.name },
    async () => {
      config.onToolStart?.(tc.name);

      // Strict JSON parse error from the provider — surface as an error result
      // without ever calling the handler.
      if (tc.input._parse_error) {
        const parseResult: ToolResult = {
          content: String(tc.input._parse_error),
          is_error: true,
        };
        config.onToolEnd?.(tc.name, parseResult);
        setSpanAttrs({ failed: true });
        return { content: parseResult.content, isError: true };
      }

      let toolResult: ToolResult;
      try {
        if (config.toolHandler) {
          toolResult = await config.toolHandler(tc.name, tc.input);
        } else {
          toolResult = { content: `No handler for tool: ${tc.name}`, is_error: true };
        }
      } catch (e) {
        toolResult = { content: `Tool error (${tc.name}): ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }

      config.onToolEnd?.(tc.name, toolResult);

      let tui: TuiCommand | undefined;
      if (tuiToolNames.has(tc.name)) {
        try {
          tui = (toolResult._tui ?? JSON.parse(toolResult.content)) as TuiCommand;
        } catch { /* not a TUI command */ }
      }

      if (tui) onTui(tui);

      // Record a few cheap, useful attributes for the timeline tooltip.
      if (toolResult.is_error) setSpanAttrs({ failed: true });
      if (tc.name === "generate_image") {
        const effort = tc.input.effort;
        const aspect = tc.input.aspect;
        setSpanAttrs({
          ...(typeof effort === "string" ? { effort } : {}),
          ...(typeof aspect === "string" ? { aspect } : {}),
        });
      }

      const isDeferred = tui !== undefined
        && DEFERRED_TUI_TYPES.has(tui.type)
        && !toolResult.is_error;
      const content = isDeferred
        ? `${toolResult.content}\n\n(Your prior narrative has been delivered to the player. End your turn unless you have new narrative to add.)`
        : toolResult.content;

      return { content, isError: toolResult.is_error ?? false };
    },
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runProviderLoop(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  config: ProviderLoopConfig,
): Promise<ProviderLoopResult> {
  const maxToolRounds = config.maxToolRounds ?? 3;
  const maxRetries = config.maxRetries ?? Number.POSITIVE_INFINITY;
  const shouldStream = config.stream !== false && !!config.onTextDelta;

  // Only enable thinking for models that support it (per model registry).
  const supportsThinking = getKnownModel(config.model)?.capabilities?.thinking ?? false;
  const ec = config.effort !== undefined
    ? { effort: supportsThinking ? config.effort : null }
    : (supportsThinking ? getEffortConfig(config.name) : { effort: null });

  const thinking: ThinkingConfig | undefined =
    ec.effort ? { effort: ec.effort } : undefined;

  // Apply terse suffix
  let effectiveSystem = systemPrompt;
  if (config.terseSuffix) {
    const suffix = "\n\nIMPORTANT: Respond in the minimum tokens necessary. Be terse.";
    if (typeof effectiveSystem === "string") {
      effectiveSystem = effectiveSystem + suffix;
    } else {
      effectiveSystem = [...effectiveSystem, { text: suffix }];
    }
  }

  const totalUsage: NormalizedUsage = {
    inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    reasoningTokens: 0,
  };
  const tuiCommands: TuiCommand[] = [];
  let fullText = "";
  // Concatenation of every round's emitted text, in the order the client saw
  // it on screen. Compared against `fullText` after the loop: if regen-aware
  // accumulation produced a shorter canonical text than what was streamed,
  // we emit a corrective rollback + re-stream so the displayed narrative
  // matches the persisted one.
  let streamedText = "";
  let truncated = false;

  const workingMessages = [...messages];
  const loopStartIndex = workingMessages.length;
  const tuiToolNames = config.tuiToolNames ?? new Set<string>();

  // Tool results from providers that dispatch tools in-band (openai-chatgpt):
  // the model already consumed these during the turn, but the bridge never
  // sees them as surfaced tool calls, so capture them here to rebuild the
  // canonical tool_use ↔ tool_result pairs in `normalizeTurn`. Stays empty for
  // loop-style providers (they ignore `dispatchTool` and surface tool calls).
  const inBandResults: CapturedToolResult[] = [];

  const priorAssistantCount = messages.filter((m) => m.role === "assistant").length;

  // Agent span: the whole loop. For the DM this is a child of the turn span
  // opened in processInput; for a subagent it's a child of the parent tool
  // span that dispatched it (ALS-propagated), giving turn → agent(dm) →
  // tool(search_campaign) → agent(search_campaign) → api_call. The per-round
  // api_call and per-call tool spans below are its children.
  return withSpan({ kind: "agent", name: config.name }, async () => {
  let roundsRun = 0;
  for (let round = 0; round < maxToolRounds; round++) {
    roundsRun++;
    // Span context for this round's in-band tool dispatch, re-anchored below.
    // codex keeps a persistent JSON-RPC connection whose dispatchTool callback,
    // on every later turn, still runs inside the ALS context captured when the
    // connection first opened (turn 1's first api_call). We pin it to the
    // current round's api_call span (set inside that span just before the
    // provider call) so tool + subagent spans land on the right turn.
    let inbandCtx: TraceContext | undefined;
    // Tool dispatcher for providers that own tool dispatch internally
    // (currently openai-chatgpt). Wraps the same per-call logic the
    // bridge runs after this chat() returns for non-internal-dispatch
    // providers — so TUI broadcast, deferred-sentinel handling, and
    // onToolStart/End callbacks fire identically regardless of which
    // path the provider takes. Other providers (Anthropic, openai-apikey)
    // ignore this field and surface tool calls back through
    // ChatResult.toolCalls.
    const dispatchTool: DispatchToolFn = async (call) => runInContext(inbandCtx, async () => {
      const dispatched = await dispatchToolCall(
        { id: call.id, name: call.name, input: call.input },
        config,
        tuiToolNames,
        (cmd) => {
          if (DEFERRED_TUI_TYPES.has(cmd.type)) {
            tuiCommands.push(cmd);
          } else {
            config.onTuiCommand?.(cmd);
          }
        },
      );
      // Record the result so the canonical turn can pair it with its tool_use
      // block — this provider won't surface the call back through toolCalls.
      inBandResults.push({
        tool_use_id: call.id,
        content: dispatched.content,
        is_error: dispatched.isError,
      });
      return { content: dispatched.content, isError: dispatched.isError };
    });

    // ChatParams is a discriminated union: tools + dispatchTool are
    // either both present (this call uses tools) or both absent (text-only).
    // Build the variant that matches `config.tools`.
    //
    // conversationId = agent name: stable across the bridge's tool-use rounds
    // and across subsequent player turns for the same agent, distinct between
    // agents (DM vs scribe vs subagents). Providers that support cache
    // diagnostics (currently Anthropic) thread `previous_message_id` along
    // this key so divergence reasons are attributed to the right chain.
    const chatParams: ChatParams = config.tools
      ? {
          model: config.model,
          systemPrompt: effectiveSystem,
          messages: workingMessages,
          tools: config.tools,
          maxTokens: config.maxTokens,
          thinking,
          cacheHints: config.cacheHints,
          conversationId: config.name,
          dispatchTool,
        }
      : {
          model: config.model,
          systemPrompt: effectiveSystem,
          messages: workingMessages,
          maxTokens: config.maxTokens,
          thinking,
          cacheHints: config.cacheHints,
          conversationId: config.name,
        };

    // Context dump: log params before API call. `thinking` is captured so the
    // dumped request reflects whether reasoning was actually requested — the
    // matching response trace (if any) flows through dumpThinking below.
    dumpContext(config.name, {
      model: chatParams.model,
      max_tokens: chatParams.maxTokens,
      system: chatParams.systemPrompt,
      thinking: chatParams.thinking,
      tools: chatParams.tools,
      messages: chatParams.messages,
    });

    // api_call span: one per round, covering the retry loop (so backoff
    // sleeps are visible in "where did the time go"). `attempts` distinguishes
    // model latency from waiting. For loop-style providers (Anthropic) this is
    // pure generation time and tool spans are siblings; for codex (in-band
    // dispatch) the provider calls dispatchTool during this span, so tool
    // spans nest under it — both shapes are causally accurate.
    const result: ChatResult = await withSpan(
      { kind: "api_call", name: config.name },
      async () => {
    // Pin this round's in-band tool dispatch (codex) to this api_call span, so
    // codex-dispatched tools nest under the round that triggered them rather
    // than the stale context its persistent connection carries.
    inbandCtx = captureContext();
    let res: ChatResult;
    // Number of tries it took to succeed (1 = first try). Assigned only on the
    // success path so there are no dead stores on retrying iterations.
    let attemptCount: number;
    const apiStart = Date.now();
    for (let attempt = 0; ; attempt++) {
      // Per-attempt flag: did this attempt actually stream any text before
      // erroring? If so, a retry needs to roll back the partial output that
      // leaked to consumers via onTextDelta.
      let attemptEmittedDeltas = false;
      const wrappedDelta = (delta: string): void => {
        if (delta) attemptEmittedDeltas = true;
        config.onTextDelta?.(delta);
      };
      try {
        if (shouldStream) {
          res = await provider.stream(chatParams, wrappedDelta);
        } else {
          res = await provider.chat(chatParams);
          // In non-streaming mode, emit the full text
          if (res.text) config.onTextDelta?.(res.text);
        }
        attemptCount = attempt + 1;
        break; // success — exit retry loop
      } catch (apiErr) {
        const status = extractStatus(apiErr);
        const retryable = status !== null
          && RETRYABLE_STATUS.has(status)
          && attempt < maxRetries;

        logEvent("api:error", {
          agent: config.name,
          model: config.model,
          durationMs: Date.now() - apiStart,
          message: apiErr instanceof Error ? apiErr.message : String(apiErr),
          status,
          attempt,
          willRetry: retryable,
          partialStream: attemptEmittedDeltas,
        });

        if (!retryable) {
          throw apiErr;
        }

        // If the failed attempt streamed any text, the next attempt will
        // re-emit it from scratch — instruct consumers to discard the
        // partial leak before we retry. Skipped when nothing leaked, so
        // pre-stream failures (e.g. immediate 429s) don't cause a needless
        // snapshot round-trip to clients.
        if (attemptEmittedDeltas) {
          config.onRollback?.();
        }

        const delay = retryDelay(attempt);
        config.onRetry?.(status, delay);
        await sleep(delay);
      }
    }

    logEvent("api:call", {
      agent: config.name,
      model: config.model,
      durationMs: Date.now() - apiStart,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheRead: res.usage.cacheReadTokens,
      cacheCreation: res.usage.cacheCreationTokens,
      reasoningTokens: res.usage.reasoningTokens,
      toolCalls: res.toolCalls.length,
      stopReason: res.stopReason,
      ...(res.cacheDiagnostics
        ? {
            cacheMissReason: res.cacheDiagnostics.reasonType,
            ...(res.cacheDiagnostics.missedInputTokens !== undefined
              ? { cacheMissedInputTokens: res.cacheDiagnostics.missedInputTokens }
              : {}),
          }
        : {}),
    });
    setSpanAttrs({
      model: config.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheRead: res.usage.cacheReadTokens,
      cacheCreation: res.usage.cacheCreationTokens,
      reasoningTokens: res.usage.reasoningTokens,
      toolCalls: res.toolCalls.length,
      stopReason: res.stopReason,
      ...(attemptCount > 1 ? { attempts: attemptCount } : {}),
      ...(res.cacheDiagnostics ? { cacheMissReason: res.cacheDiagnostics.reasonType } : {}),
    });
    return res;
      },
    );

    // Accumulate usage
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;
    totalUsage.cacheReadTokens += result.usage.cacheReadTokens;
    totalUsage.cacheCreationTokens += result.usage.cacheCreationTokens;
    totalUsage.reasoningTokens += result.usage.reasoningTokens;

    // Content refusal
    if (result.stopReason === "refusal") {
      const err = new ContentRefusalError();
      err.usage = {
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        cacheReadTokens: totalUsage.cacheReadTokens,
        cacheCreationTokens: totalUsage.cacheCreationTokens,
      };
      throw err;
    }

    // Dump thinking
    if (result.thinkingText) {
      dumpThinking(config.name, priorAssistantCount + round, result.thinkingText);
    }

    // Regen-aware accumulation. The model can do one of two things after a
    // deferred-TUI tool_result:
    //   (a) Regenerate the prior round's narrative verbatim or near-verbatim
    //       (it reads the synthetic "queue confirmation" ack ambiguously,
    //       even with the "narrative delivered" suffix, especially under
    //       deep context pressure). We must NOT concatenate, or the
    //       persisted transcript doubles up.
    //   (b) Add a genuine continuation — a coda, a follow-up beat, a "and
    //       then the door creaked open." This is exactly what the
    //       "end your turn unless you have new narrative to add" hint
    //       invites, and the model does take that invitation. We must
    //       concatenate, or the new narrative is silently dropped (#485).
    // Distinguish by prefix overlap: a regen typically shares a long opening
    // with the prior text; a continuation starts somewhere genuinely new.
    // Both branches also drive the post-loop corrective rollback below —
    // streamedText tracks what the client actually saw on screen, fullText
    // tracks what should be persisted, and any divergence at the end of the
    // turn means we need to re-stream the canonical text.
    if (result.text) {
      streamedText += result.text;
      if (fullText && looksLikeRegeneration(fullText, result.text)) {
        fullText = result.text;
      } else {
        fullText += result.text;
      }
    }

    // Process tool calls concurrently. Sync handlers still run sequentially
    // on the JS event loop; async handlers (subagent spawns, search) genuinely
    // overlap. The model can batch independent calls in one response to save
    // API round-trips.
    //
    // Per-call dispatch is delegated to `dispatchToolCall` (used both here
    // and by the dispatchTool closure in chatParams above for providers
    // that handle tool dispatch internally) so the deferred-sentinel
    // semantics, TUI broadcast, and callback firing happen uniformly.
    const settled = await Promise.all(
      result.toolCalls.map(async (tc) => {
        const tuiSink: TuiCommand[] = [];
        const dispatched = await dispatchToolCall(
          tc,
          config,
          tuiToolNames,
          (cmd) => {
            if (DEFERRED_TUI_TYPES.has(cmd.type)) {
              tuiCommands.push(cmd);
            } else {
              tuiSink.push(cmd);
            }
          },
        );
        return {
          result: {
            type: "tool_result" as const,
            tool_use_id: tc.id,
            content: dispatched.content,
            is_error: dispatched.isError,
          },
          tuiToBroadcast: tuiSink,
        };
      }),
    );

    // Broadcast non-deferred TUI commands in call-order.
    const toolResults: ContentPart[] = [];
    for (const s of settled) {
      toolResults.push(s.result);
      for (const cmd of s.tuiToBroadcast) {
        config.onTuiCommand?.(cmd);
      }
    }

    // Append assistant message (without thinking blocks)
    workingMessages.push({ role: "assistant", content: result.assistantContent });

    // No tool calls → done
    if (result.toolCalls.length === 0 || result.stopReason === "end") {
      break;
    }

    // Append tool results as user message
    workingMessages.push({ role: "user", content: toolResults });

    if (round === maxToolRounds - 1) {
      truncated = true;
    }
  }

  // Post-loop corrective rollback: if regen detection collapsed multiple
  // rounds into a shorter canonical text, the client's narrative log holds
  // the un-collapsed stream (regen showed up twice on screen). Clear it via
  // the snapshot path and re-stream the canonical text so what the player
  // sees matches what we persist. No-op in the common case where every
  // round was a genuine continuation, since streamedText === fullText.
  if (shouldStream && streamedText !== fullText) {
    config.onRollback?.();
    if (fullText) config.onTextDelta?.(fullText);
  }

  config.onComplete?.(totalUsage);

  setSpanAttrs({
    rounds: roundsRun,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cacheRead: totalUsage.cacheReadTokens,
    cacheCreation: totalUsage.cacheCreationTokens,
    reasoningTokens: totalUsage.reasoningTokens,
    ...(truncated ? { truncated: true } : {}),
  });

  return {
    text: fullText,
    tuiCommands,
    usage: totalUsage,
    truncated,
    turnMessages: normalizeTurn(
      workingMessages.slice(loopStartIndex),
      inBandResults,
      fullText,
    ),
  };
  });
}

/**
 * Heuristic: does `next` look like the model regenerating `prior`, as opposed
 * to adding a continuation? Used at round boundaries to decide whether to
 * overwrite (regen) or concatenate (continuation) accumulated text.
 *
 * Two strong signals:
 *  - One text fully contains the other: clear regen (with possible extension).
 *  - The two share a long common prefix (>= 64 chars): the model started the
 *    new round by re-typing the prior round, almost always a regen.
 *
 * Tuned to favor false negatives (treat as continuation) over false positives
 * (treat as regen). Wrongly treating a regen as continuation just duplicates
 * text on screen — annoying but recoverable. Wrongly treating a continuation
 * as regen silently drops narrative the player can never recover (#485).
 */
function looksLikeRegeneration(prior: string, next: string): boolean {
  const p = prior.trim();
  const n = next.trim();
  if (!p || !n) return false;
  if (n.includes(p) || p.includes(n)) return true;
  const limit = Math.min(p.length, n.length);
  let i = 0;
  while (i < limit && p.charCodeAt(i) === n.charCodeAt(i)) i++;
  return i >= 64;
}
