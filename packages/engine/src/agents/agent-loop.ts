import type Anthropic from "@anthropic-ai/sdk";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import {
  runAgentLoop,
  TUI_TOOLS,
  stampToolsCacheControl,
} from "./agent-session.js";
import { runProviderLoop } from "../providers/agent-loop-bridge.js";
import type { LLMProvider, NormalizedMessage, NormalizedTool } from "../providers/types.js";

// --- Types (canonical definitions, re-exported for backward compatibility) ---

export type ModelId = string;

export interface AgentLoopConfig {
  model: ModelId;
  /** LLM provider to use. When set, bypasses the Anthropic SDK path. */
  provider?: LLMProvider;
  maxTokens: number;
  maxToolRounds: number;
  /** Effort level. Omit to auto-resolve from agent name. */
  effort?: import("../config/models.js").EffortLevel | null;
  /** Async tool handler override. Called before registry dispatch.
   *  Return a ToolResult to handle the tool, or null to fall through to registry. */
  asyncToolHandler?: (name: string, input: Record<string, unknown>) => Promise<ToolResult | null>;
  /** Called when DM text streams in */
  onTextDelta?: (delta: string) => void;
  /** Called when a tool call starts */
  onToolStart?: (name: string) => void;
  /** Called when a tool call completes */
  onToolEnd?: (name: string, result: ToolResult) => void;
  /** Called when the full response is complete */
  onComplete?: (usage: UsageStats) => void;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called when a retryable error triggers a backoff wait */
  onRetry?: (status: number, delayMs: number) => void;
}

import type { UsageStats, TuiCommand } from "@machine-violet/shared/types/engine.js";
export type { UsageStats, TuiCommand } from "@machine-violet/shared/types/engine.js";

export interface AgentLoopResult {
  /** Text content from the assistant's final response */
  text: string;
  /** TUI commands emitted by tool calls */
  tuiCommands: TuiCommand[];
  /** Total usage across all rounds */
  usage: UsageStats;
  /** Whether the loop was cut short by maxToolRounds */
  truncated: boolean;
  /**
   * All messages appended during this loop (assistant + tool_result pairs).
   * Normally ends with the final assistant message, but when `truncated` is
   * true it may end with a user tool_result instead.
   */
  roundMessages: Anthropic.MessageParam[];
}

// Re-export stampToolsCacheControl from agent-session for backward compatibility
export { stampToolsCacheControl };

// --- Agent Loop ---

/**
 * Run one turn of the agent loop: send messages, stream response,
 * handle tool_use blocks, loop until end_turn or max rounds.
 */
export async function agentLoop(
  client: Anthropic | null,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  const toolHandler = asyncHandler
    ? async (name: string, input: Record<string, unknown>) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
    : (name: string, input: Record<string, unknown>) => registry.dispatch(gameState, name, input);

  // Provider path: use the provider-agnostic loop
  if (config.provider) {
    return runViaProvider(config.provider, systemPrompt, messages, registry, {
      ...config, stream: false, toolHandler,
    });
  }

  // Legacy Anthropic path
  if (!client) throw new Error("No Anthropic client or LLM provider configured");
  return runAgentLoop(client, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    effort: config.effort,
    stream: false,
    tools: registry.getDefinitions(),
    toolHandler,
    retry: true,
    cacheTools: true,
    tuiToolNames: TUI_TOOLS,
    onTextDelta: config.onTextDelta,
    onToolStart: config.onToolStart,
    onToolEnd: config.onToolEnd,
    onComplete: config.onComplete,
    onError: config.onError,
    onRetry: config.onRetry,
  });
}

// --- Streaming variant ---

/**
 * Run one turn of the agent loop with streaming.
 * Text deltas are emitted via onTextDelta as they arrive.
 */
export async function agentLoopStreaming(
  client: Anthropic | null,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  const toolHandler = asyncHandler
    ? async (name: string, input: Record<string, unknown>) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
    : (name: string, input: Record<string, unknown>) => registry.dispatch(gameState, name, input);

  // Provider path
  if (config.provider) {
    return runViaProvider(config.provider, systemPrompt, messages, registry, {
      ...config, stream: true, toolHandler,
    });
  }

  // Legacy Anthropic path
  if (!client) throw new Error("No Anthropic client or LLM provider configured");
  return runAgentLoop(client, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    effort: config.effort,
    stream: true,
    tools: registry.getDefinitions(),
    toolHandler,
    retry: true,
    cacheTools: true,
    tuiToolNames: TUI_TOOLS,
    onTextDelta: config.onTextDelta,
    onToolStart: config.onToolStart,
    onToolEnd: config.onToolEnd,
    onComplete: config.onComplete,
    onError: config.onError,
    onRetry: config.onRetry,
  });
}

// ---------------------------------------------------------------------------
// Provider bridge: converts between provider-agnostic and Anthropic types
// ---------------------------------------------------------------------------

async function runViaProvider(
  provider: LLMProvider,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  registry: ToolRegistry,
  config: AgentLoopConfig & { stream: boolean; toolHandler: (name: string, input: Record<string, unknown>) => ToolResult | Promise<ToolResult> },
): Promise<AgentLoopResult> {
  // Convert system prompt
  const normalizedSystem = typeof systemPrompt === "string"
    ? systemPrompt
    : systemPrompt.map((b) => ({
        text: b.text,
        ...(("cache_control" in b && b.cache_control)
          ? { cacheControl: { ttl: (b.cache_control as { ttl?: string }).ttl === "1h" ? "1h" as const : "5m" as const } }
          : {}),
      }));

  // Convert messages: Anthropic.MessageParam[] → NormalizedMessage[]
  const normalizedMessages: NormalizedMessage[] = messages.map(anthropicToNormalized);

  // Convert tools
  const defs = registry.getDefinitions();
  const normalizedTools: NormalizedTool[] = defs.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as Record<string, unknown>,
  }));

  const result = await runProviderLoop(provider, normalizedSystem, normalizedMessages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    effort: config.effort,
    stream: config.stream,
    tools: normalizedTools,
    toolHandler: config.toolHandler,
    cacheHints: [{ target: "tools", ttl: "1h" }],
    tuiToolNames: TUI_TOOLS,
    onTextDelta: config.onTextDelta,
    onToolStart: config.onToolStart,
    onToolEnd: config.onToolEnd,
    onComplete: config.onComplete,
    onError: config.onError,
  });

  // Convert result messages back to Anthropic.MessageParam[] for ConversationManager
  const roundMessages: Anthropic.MessageParam[] = result.roundMessages.map(normalizedToAnthropic);

  return {
    text: result.text,
    tuiCommands: result.tuiCommands,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
    },
    truncated: result.truncated,
    roundMessages,
  };
}

/** Convert Anthropic.MessageParam → NormalizedMessage */
function anthropicToNormalized(msg: Anthropic.MessageParam): NormalizedMessage {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  const parts = (msg.content as Anthropic.ContentBlock[]).map((block): import("../providers/types.js").ContentPart => {
    if ("type" in block && block.type === "text") {
      return { type: "text", text: (block as { text: string }).text };
    }
    if ("type" in block && block.type === "tool_use") {
      const tu = block as { id: string; name: string; input: Record<string, unknown> };
      return { type: "tool_use", id: tu.id, name: tu.name, input: tu.input };
    }
    if ("type" in block && block.type === "tool_result") {
      const tr = block as { tool_use_id: string; content: string; is_error?: boolean };
      return { type: "tool_result", tool_use_id: tr.tool_use_id, content: tr.content, is_error: tr.is_error };
    }
    return { type: "text", text: "" };
  });
  return { role: msg.role, content: parts };
}

/** Convert NormalizedMessage → Anthropic.MessageParam */
function normalizedToAnthropic(msg: NormalizedMessage): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  const content = msg.content.map((part): Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "tool_use") return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    if (part.type === "tool_result") return { type: "tool_result", tool_use_id: part.tool_use_id, content: part.content, is_error: part.is_error };
    return { type: "text", text: "" };
  });
  return { role: msg.role, content };
}

