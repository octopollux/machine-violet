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
import { dumpContext, dumpThinking } from "../config/context-dump.js";
import { ContentRefusalError } from "@machine-violet/shared/types/errors.js";
import { getEffortConfig } from "../config/models.js";
import type { EffortLevel } from "../config/models.js";

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
  terseSuffix?: boolean;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, result: ToolResult) => void;
  onComplete?: (usage: NormalizedUsage) => void;
  onError?: (error: Error) => void;
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
  const shouldStream = config.stream !== false && !!config.onTextDelta;

  const ec = config.effort !== undefined
    ? { effort: config.effort }
    : getEffortConfig(config.name);

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

  const workingMessages = [...messages];
  const loopStartIndex = workingMessages.length;
  const tuiToolNames = config.tuiToolNames ?? new Set<string>();

  const priorAssistantCount = messages.filter((m) => m.role === "assistant").length;

  for (let round = 0; round < maxToolRounds; round++) {
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
    if (shouldStream) {
      result = await provider.stream(chatParams, (delta) => config.onTextDelta?.(delta));
    } else {
      result = await provider.chat(chatParams);
      // In non-streaming mode, emit the full text
      if (result.text) config.onTextDelta?.(result.text);
    }

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

    fullText += result.text;

    // Process tool calls concurrently. Sync handlers still run sequentially
    // on the JS event loop; async handlers (subagent spawns, search) genuinely
    // overlap. The model can batch independent calls in one response to save
    // API round-trips.
    const toolResults: ContentPart[] = await Promise.all(
      result.toolCalls.map(async (tc): Promise<ContentPart> => {
        config.onToolStart?.(tc.name);

        // Check for parse errors from strict JSON parsing
        if (tc.input._parse_error) {
          const parseResult: ToolResult = {
            content: String(tc.input._parse_error),
            is_error: true,
          };
          config.onToolEnd?.(tc.name, parseResult);
          return {
            type: "tool_result",
            tool_use_id: tc.id,
            content: parseResult.content,
            is_error: true,
          };
        }

        let toolResult: ToolResult;
        if (config.toolHandler) {
          toolResult = await config.toolHandler(tc.name, tc.input);
        } else {
          toolResult = { content: `No handler for tool: ${tc.name}`, is_error: true };
        }

        config.onToolEnd?.(tc.name, toolResult);

        if (tuiToolNames.has(tc.name)) {
          try {
            const tui = toolResult._tui ?? JSON.parse(toolResult.content);
            tuiCommands.push(tui as TuiCommand);
          } catch { /* not a TUI command */ }
        }

        return {
          type: "tool_result",
          tool_use_id: tc.id,
          content: toolResult.content,
          is_error: toolResult.is_error,
        };
      }),
    );

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
