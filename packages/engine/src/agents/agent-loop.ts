import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { runProviderLoop } from "../providers/agent-loop-bridge.js";
import type { LLMProvider, NormalizedMessage, SystemBlock } from "../providers/types.js";

// --- TUI tools ---

export const TUI_TOOLS = new Set([
  "update_modeline",
  "set_theme",
  "style_scene",
  "set_display_resources",
  "set_resource_values",
  "present_choices",
  "show_character_sheet",
  "enter_ooc",
  "scene_transition",
  "session_end",
  "scribe",
  "dm_notes",
  "promote_character",
]);

/** Tools registered in the ToolRegistry but only exposed to OOC / Dev Mode agents. */
const DM_EXCLUDED_TOOLS = new Set(["show_character_sheet", "rollback"]);

export function isTuiCommand(toolName: string): boolean {
  return TUI_TOOLS.has(toolName);
}

// --- Types (canonical definitions) ---

export type ModelId = string;

export interface AgentLoopConfig {
  model: ModelId;
  /** LLM provider to use. */
  provider: LLMProvider;
  maxTokens: number;
  maxToolRounds: number;
  /** Effort level. Omit to auto-resolve from agent name. */
  effort?: import("../config/models.js").EffortLevel | null;
  /** Async tool handler override. Called before registry dispatch.
   *  Return a ToolResult to handle the tool, or null to fall through to registry. */
  asyncToolHandler?: (name: string, input: Record<string, unknown>) => Promise<ToolResult | null>;
  /** Called when DM text streams in */
  onTextDelta?: (delta: string) => void;
  /** Called immediately when a non-deferred TUI command is extracted from a tool result */
  onTuiCommand?: (cmd: TuiCommand) => void;
  /** Called when a tool call starts */
  onToolStart?: (name: string) => void;
  /** Called when a tool call completes */
  onToolEnd?: (name: string, result: ToolResult) => void;
  /** Called when the full response is complete */
  onComplete?: (usage: UsageStats) => void;
  /** Called on error */
  onError?: (error: Error) => void;
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
  roundMessages: NormalizedMessage[];
}

// --- Agent Loop ---

/**
 * Run one turn of the agent loop: send messages, stream response,
 * handle tool_use blocks, loop until end_turn or max rounds.
 */
export async function agentLoop(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  return runAgentLoopInternal(provider, systemPrompt, messages, registry, gameState, config, false);
}

// --- Streaming variant ---

/**
 * Run one turn of the agent loop with streaming.
 * Text deltas are emitted via onTextDelta as they arrive.
 */
export async function agentLoopStreaming(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  return runAgentLoopInternal(provider, systemPrompt, messages, registry, gameState, config, true);
}

// --- Internal ---

async function runAgentLoopInternal(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
  stream: boolean,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  const toolHandler = asyncHandler
    ? async (name: string, input: Record<string, unknown>) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
    : (name: string, input: Record<string, unknown>) => registry.dispatch(gameState, name, input);

  const result = await runProviderLoop(provider, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    effort: config.effort,
    stream,
    tools: registry.getDefinitions(DM_EXCLUDED_TOOLS),
    toolHandler,
    cacheHints: [{ target: "tools", ttl: "1h" }, { target: "messages" }],
    tuiToolNames: TUI_TOOLS,
    onTuiCommand: config.onTuiCommand,
    onTextDelta: config.onTextDelta,
    onToolStart: config.onToolStart,
    onToolEnd: config.onToolEnd,
    onComplete: config.onComplete,
    onError: config.onError,
  });

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
    roundMessages: result.roundMessages,
  };
}
