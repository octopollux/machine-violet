import type Anthropic from "@anthropic-ai/sdk";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import {
  runAgentLoop,
  TUI_TOOLS,
  stampToolsCacheControl,
} from "./agent-session.js";

// --- Types (canonical definitions, re-exported for backward compatibility) ---

export type ModelId = "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-sonnet-4-5-20250929" | "claude-haiku-4-5-20251001";

export interface AgentLoopConfig {
  model: ModelId;
  maxTokens: number;
  maxToolRounds: number;
  /** Extended thinking config. Omit or undefined to disable. */
  thinking?: Anthropic.Messages.ThinkingConfigParam;
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

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** TUI command emitted by TUI tools (update_modeline, set_ui_style, etc.) */
export interface TuiCommand {
  type: string;
  [key: string]: unknown;
}

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
  client: Anthropic,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  return runAgentLoop(client, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    thinking: config.thinking,
    stream: false,
    tools: registry.getDefinitions(),
    toolHandler: asyncHandler
      ? async (name, input) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
      : (name, input) => registry.dispatch(gameState, name, input),
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
  client: Anthropic,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  return runAgentLoop(client, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    thinking: config.thinking,
    stream: true,
    tools: registry.getDefinitions(),
    toolHandler: asyncHandler
      ? async (name, input) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
      : (name, input) => registry.dispatch(gameState, name, input),
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

