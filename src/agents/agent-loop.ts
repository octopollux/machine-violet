import Anthropic from "@anthropic-ai/sdk";
import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { accumulateUsage } from "../context/usage-helpers.js";
import { dumpContext } from "../config/context-dump.js";

// --- Types ---

export type ModelId = "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-sonnet-4-5-20250929" | "claude-haiku-4-5-20251001";

export interface AgentLoopConfig {
  model: ModelId;
  maxTokens: number;
  maxToolRounds: number;
  /** Extended thinking config. Omit or undefined to disable. */
  thinking?: Anthropic.Messages.ThinkingConfigParam;
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

export interface Exchange {
  role: "user" | "assistant";
  content: Anthropic.MessageParam["content"];
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
}

// --- Constants ---

/**
 * Exponential backoff: 1s, 2s, 4s, 8s, 12s, then 12s forever.
 * We never give up — the player's game is worth waiting for.
 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 12_000;

function retryDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

/** Status 0 is synthetic — used for network-level errors (no HTTP status). */
const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503, 529]);

// --- Cache helpers ---

/**
 * Stamp cache_control on the last tool definition so the entire tools block
 * is cached with a 1-hour TTL. Per the API spec, a breakpoint on the last
 * tool caches everything before it in the tools array.
 *
 * This uses 1 of the 4 available explicit cache breakpoints (the other 3
 * are on system prompt blocks in prefix-builder.ts).
 */
export function stampToolsCacheControl(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const result = [...tools];
  const last = { ...result[result.length - 1] };
  (last as Record<string, unknown>)["cache_control"] = { type: "ephemeral", ttl: "1h" };
  result[result.length - 1] = last;
  return result;
}

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
  const tools = stampToolsCacheControl(registry.getDefinitions());
  const totalUsage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const tuiCommands: TuiCommand[] = [];
  let fullText = "";
  let truncated = false;

  // Working copy of messages — we append tool results as we go
  const workingMessages = [...messages];

  for (let round = 0; round < config.maxToolRounds; round++) {
    const response = await callWithRetry(client, {
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages: workingMessages,
      tools,
      thinking: config.thinking,
    }, config);

    // Accumulate usage
    accumulateUsage(totalUsage, response.usage);

    // Process content blocks
    let hasToolUse = false;
    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      // Skip thinking blocks — they must not be sent back in conversation history
      if (block.type === "thinking") continue;

      assistantContent.push(block);

      if (block.type === "text") {
        fullText += block.text;
        config.onTextDelta?.(block.text);
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        config.onToolStart?.(block.name);

        const result = registry.dispatch(
          gameState,
          block.name,
          block.input as Record<string, unknown>,
        );

        config.onToolEnd?.(block.name, result);

        // Check if this is a TUI command
        if (isTuiCommand(block.name)) {
          try {
            tuiCommands.push(JSON.parse(result.content) as TuiCommand);
          } catch { /* not a TUI command after all */ }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        });
      }
    }

    // Append assistant message
    workingMessages.push({
      role: "assistant",
      content: assistantContent,
    });

    // If no tool use, we're done
    if (!hasToolUse || response.stop_reason === "end_turn") {
      break;
    }

    // Append tool results as user message
    workingMessages.push({
      role: "user",
      content: toolResults,
    });

    // Check if we're at max rounds
    if (round === config.maxToolRounds - 1) {
      truncated = true;
    }
  }

  const usage = totalUsage;
  config.onComplete?.(usage);

  return { text: fullText, tuiCommands, usage, truncated };
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
  const tools = stampToolsCacheControl(registry.getDefinitions());
  const totalUsage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const tuiCommands: TuiCommand[] = [];
  let fullText = "";
  let truncated = false;

  const workingMessages = [...messages];

  for (let round = 0; round < config.maxToolRounds; round++) {
    const { message, usage } = await streamWithRetry(client, {
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt,
      messages: workingMessages,
      tools,
      thinking: config.thinking,
    }, config);

    accumulateUsage(totalUsage, usage);

    // Process completed message
    let hasToolUse = false;
    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of message.content) {
      // Skip thinking blocks — they must not be sent back in conversation history
      if (block.type === "thinking") continue;

      assistantContent.push(block);

      if (block.type === "text") {
        fullText += block.text;
        // Text was already streamed via onTextDelta during streaming
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        config.onToolStart?.(block.name);

        const result = registry.dispatch(
          gameState,
          block.name,
          block.input as Record<string, unknown>,
        );

        config.onToolEnd?.(block.name, result);

        if (isTuiCommand(block.name)) {
          try {
            tuiCommands.push(JSON.parse(result.content) as TuiCommand);
          } catch { /* not a TUI command */ }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        });
      }
    }

    workingMessages.push({ role: "assistant", content: assistantContent });

    if (!hasToolUse || message.stop_reason === "end_turn") {
      break;
    }

    workingMessages.push({ role: "user", content: toolResults });

    if (round === config.maxToolRounds - 1) {
      truncated = true;
    }
  }

  config.onComplete?.(totalUsage);
  return { text: fullText, tuiCommands, usage: totalUsage, truncated };
}

// --- Internal helpers ---

const TUI_TOOLS = new Set([
  "update_modeline",
  "set_ui_style",
  "set_display_resources",
  "present_choices",
  "present_roll",
  "show_character_sheet",
  "enter_ooc",
  "scene_transition",
  "session_end",
  "context_refresh",
  "validate",
  "create_entity",
  "update_entity",
]);

function isTuiCommand(toolName: string): boolean {
  return TUI_TOOLS.has(toolName);
}

interface CreateParams {
  model: string;
  max_tokens: number;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  thinking?: Anthropic.Messages.ThinkingConfigParam;
}

async function callWithRetry(
  client: Anthropic,
  params: CreateParams,
  config: AgentLoopConfig,
): Promise<Anthropic.Message> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext("dm", params);
      return await client.messages.create({
        ...params,
        stream: false,
      });
    } catch (e) {
      const status = extractStatus(e);
      if (status === null || !RETRYABLE_STATUS.has(status)) {
        const error = e instanceof Error ? e : new Error(String(e));
        config.onError?.(error);
        throw error;
      }
      const delay = retryDelay(attempt);
      config.onRetry?.(status, delay);
      await sleep(delay);
    }
  }
}

async function streamWithRetry(
  client: Anthropic,
  params: CreateParams,
  config: AgentLoopConfig,
): Promise<{ message: Anthropic.Message; usage: Anthropic.Usage }> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext("dm", params);
      const stream = client.messages.stream({
        ...params,
      });

      // Wire up text streaming
      stream.on("text", (delta) => {
        config.onTextDelta?.(delta);
      });

      const message = await stream.finalMessage();
      return { message, usage: message.usage };
    } catch (e) {
      const status = extractStatus(e);
      if (status === null || !RETRYABLE_STATUS.has(status)) {
        const error = e instanceof Error ? e : new Error(String(e));
        config.onError?.(error);
        throw error;
      }
      const delay = retryDelay(attempt);
      config.onRetry?.(status, delay);
      await sleep(delay);
    }
  }
}

/** Patterns that indicate a network-level (not application-level) failure. */
const NETWORK_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "fetch failed",
  "socket hang up",
  "network error",
  "connection error",
  "Failed to fetch",
  "EPIPE",
];

function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status: number }).status;
    if (typeof status === "number") return status;
  }
  const msg = e instanceof Error ? e.message : String(e);
  // Detect overloaded errors that may lack a numeric status
  // (e.g. streamed error events with type "overloaded_error")
  if (msg.includes("overloaded")) return 529;
  // Detect network-level errors (no HTTP status at all)
  const lower = msg.toLowerCase();
  for (const pat of NETWORK_ERROR_PATTERNS) {
    if (lower.includes(pat.toLowerCase())) return 0;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @internal — exported for tests only */
export const _internal = { extractStatus, retryDelay };
