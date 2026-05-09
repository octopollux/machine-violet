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
  LLMProvider, ChatParams, ChatResult,
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
]);
import { dumpContext, dumpThinking } from "../config/context-dump.js";
import { logEvent } from "../context/engine-log.js";
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
  /** Max retries after the initial attempt (default 5 → up to 6 total attempts, ~27s backoff). */
  maxRetries?: number;
}

export interface ProviderLoopResult {
  text: string;
  tuiCommands: TuiCommand[];
  usage: NormalizedUsage;
  truncated: boolean;
  roundMessages: NormalizedMessage[];
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
  const maxRetries = config.maxRetries ?? 5;
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
  let truncated = false;
  // Tracks whether the round we just completed emitted any text deltas.
  // Used to roll the client back at the boundary into the next round —
  // see the inter-round rollback comment inside the loop.
  let priorRoundEmittedText = false;

  const workingMessages = [...messages];
  const loopStartIndex = workingMessages.length;
  const tuiToolNames = config.tuiToolNames ?? new Set<string>();

  const priorAssistantCount = messages.filter((m) => m.role === "assistant").length;

  for (let round = 0; round < maxToolRounds; round++) {
    // Inter-round rollback: when a round emitted narrative text alongside a
    // tool call (typically a deferred TUI tool like scribe / scene_transition
    // / dm_notes), Claude often re-narrates the same content in the next
    // round after seeing the synthetic tool_result. The streamed deltas from
    // round N are still in the client's narrative log; without a rollback,
    // round N+1's stream is appended after them and the user sees the same
    // text twice. Reuse the retry-rollback path so the bridge clears its
    // delta buffer and the session-manager publishes a corrective snapshot
    // before round N+1's deltas begin arriving.
    if (priorRoundEmittedText) {
      config.onRollback?.();
    }

    const chatParams: ChatParams = {
      model: config.model,
      systemPrompt: effectiveSystem,
      messages: workingMessages,
      tools: config.tools,
      maxTokens: config.maxTokens,
      thinking,
      cacheHints: config.cacheHints,
    };

    // Context dump: log params before API call
    dumpContext(config.name, {
      model: chatParams.model,
      max_tokens: chatParams.maxTokens,
      system: chatParams.systemPrompt,
      tools: chatParams.tools,
      messages: chatParams.messages,
    });

    let result: ChatResult;
    let roundEmittedDeltas: boolean;
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
          result = await provider.stream(chatParams, wrappedDelta);
        } else {
          result = await provider.chat(chatParams);
          // In non-streaming mode, emit the full text
          if (result.text) config.onTextDelta?.(result.text);
        }
        // Successful attempt: capture whether deltas leaked so the
        // inter-round rollback at the top of the next iteration knows
        // whether a corrective snapshot is needed. Per-attempt rollbacks
        // for retries already cleared the failed-attempt streams; this
        // flag reflects only the surviving (successful) attempt.
        roundEmittedDeltas = shouldStream ? attemptEmittedDeltas : !!result.text;
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
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheRead: result.usage.cacheReadTokens,
      cacheCreation: result.usage.cacheCreationTokens,
      reasoningTokens: result.usage.reasoningTokens,
      toolCalls: result.toolCalls.length,
      stopReason: result.stopReason,
    });

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

    // Last-non-empty-round-wins: each round with text overwrites prior text.
    // When the model emits text alongside a tool call and then re-narrates
    // after the tool_result (Claude does this routinely with deferred TUI
    // tools, see the inter-round rollback comment above), accumulating across
    // rounds doubles the response in every downstream sink — display log,
    // scene transcript, committed narrative, etc. Overwriting keeps
    // `result.text` consistent with the final assistant message in
    // `roundMessages`, which is what the conversation history already
    // collapses to via `finalAssistantText` in game-engine.ts. The non-empty
    // guard preserves the prior round's text for the unusual case where the
    // model said its piece alongside a tool call and then end_turn'd in the
    // next round without further narration.
    if (result.text) {
      fullText = result.text;
    }
    priorRoundEmittedText = roundEmittedDeltas;

    // Process tool calls concurrently. Sync handlers still run sequentially
    // on the JS event loop; async handlers (subagent spawns, search) genuinely
    // overlap. The model can batch independent calls in one response to save
    // API round-trips.
    //
    // Each handler is wrapped in try/catch so a single throw doesn't abort
    // the entire batch. TUI commands are collected per-result and appended
    // in call-order after Promise.all (not completion-order).
    const settled = await Promise.all(
      result.toolCalls.map(async (tc): Promise<{ result: ContentPart; tui?: TuiCommand }> => {
        config.onToolStart?.(tc.name);

        // Check for parse errors from strict JSON parsing
        if (tc.input._parse_error) {
          const parseResult: ToolResult = {
            content: String(tc.input._parse_error),
            is_error: true,
          };
          config.onToolEnd?.(tc.name, parseResult);
          return {
            result: {
              type: "tool_result",
              tool_use_id: tc.id,
              content: parseResult.content,
              is_error: true,
            },
          };
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

        // Deferred TUI tools (scribe, scene_transition, dm_notes,
        // promote_character, session_end) execute server-side after the
        // agent loop returns, so their tool_result is just a queue
        // confirmation. Without an explicit signal that the prior narrative
        // was already delivered, the model treats the generic ack
        // ambiguously and frequently re-narrates in the next round —
        // verbatim or lightly regenerated, but always wasting an inference
        // call. Append a uniform signal here so tool handlers don't each
        // have to remember to include it (and so updating the wording is
        // a one-line change). Skipped on errors so failure messages aren't
        // diluted, and on non-deferred TUI tools (update_modeline,
        // set_resource_values, etc.) where the model often continues
        // narrating mid-turn legitimately.
        const isDeferred = tui !== undefined
          && DEFERRED_TUI_TYPES.has(tui.type)
          && !toolResult.is_error;
        const content = isDeferred
          ? `${toolResult.content}\n\n(Your prior narrative has been delivered to the player. End your turn unless you have new narrative to add.)`
          : toolResult.content;

        return {
          result: {
            type: "tool_result",
            tool_use_id: tc.id,
            content,
            is_error: toolResult.is_error,
          },
          tui,
        };
      }),
    );

    // Collect results and TUI commands in call-order (not completion-order).
    // Non-deferred (visual) commands are broadcast immediately so the client
    // sees updates as tools fire; deferred commands are collected for
    // post-loop engine processing.
    const toolResults: ContentPart[] = [];
    for (const s of settled) {
      toolResults.push(s.result);
      if (s.tui) {
        if (DEFERRED_TUI_TYPES.has(s.tui.type)) {
          tuiCommands.push(s.tui);
        } else {
          config.onTuiCommand?.(s.tui);
        }
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

  config.onComplete?.(totalUsage);

  return {
    text: fullText,
    tuiCommands,
    usage: totalUsage,
    truncated,
    roundMessages: workingMessages.slice(loopStartIndex),
  };
}
