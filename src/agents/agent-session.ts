import Anthropic from "@anthropic-ai/sdk";
import type { ToolResult } from "./tool-registry.js";
import type { UsageStats, TuiCommand, ModelId } from "./agent-loop.js";
import { accumulateUsage } from "../context/usage-helpers.js";
import { dumpContext, dumpThinking } from "../config/context-dump.js";
import { getThinkingConfig } from "../config/models.js";

// --- Types ---

/** Unified tool handler — both ToolRegistry.dispatch and bare handlers conform. */
export type ToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => ToolResult | Promise<ToolResult>;

export interface AgentSessionConfig {
  /** Agent name — used for logging / thinking config lookup. */
  name: string;
  /** Model to use for this session. */
  model: ModelId;
  /** Max output tokens. */
  maxTokens: number;
  /** Max tool-use rounds before cutting off (default 3). */
  maxToolRounds?: number;
  /** Extended thinking config. Auto-resolved from name if omitted. */
  thinking?: Anthropic.Messages.ThinkingConfigParam;
  /** Whether to stream (default true). */
  stream?: boolean;
  /** Tool definitions available to this session. */
  tools?: Anthropic.Tool[];
  /** Tool handler for dispatching tool_use blocks. */
  toolHandler?: ToolHandler;
  /** Enable exponential backoff retry (default false). */
  retry?: boolean;
  /** Append "Be terse." suffix to system prompt (default false). */
  terseSuffix?: boolean;
  /** Stamp cache_control on last tool definition (default false). */
  cacheTools?: boolean;
  /** Tools whose results are TUI commands. */
  tuiToolNames?: Set<string>;
  /** Called when text streams in (streaming mode only). */
  onTextDelta?: (delta: string) => void;
  /** Called when a tool call starts. */
  onToolStart?: (name: string) => void;
  /** Called when a tool call completes. */
  onToolEnd?: (name: string, result: ToolResult) => void;
  /** Called when the full response is complete. */
  onComplete?: (usage: UsageStats) => void;
  /** Called on non-retryable error. */
  onError?: (error: Error) => void;
  /** Called when a retryable error triggers a backoff wait. */
  onRetry?: (status: number, delayMs: number) => void;
}

export interface AgentSessionResult {
  /** Accumulated text content from all rounds. */
  text: string;
  /** TUI commands emitted by tool calls. */
  tuiCommands: TuiCommand[];
  /** Total usage across all rounds. */
  usage: UsageStats;
  /** Whether the loop was cut short by maxToolRounds. */
  truncated: boolean;
  /**
   * All messages appended during this loop (assistant + tool_result pairs).
   * Normally ends with the final assistant message, but when `truncated` is
   * true it may end with a user tool_result instead.
   */
  roundMessages: Anthropic.MessageParam[];
}

// --- Constants ---

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 12_000;

export function retryDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

/** Status 0 is synthetic — used for network-level errors (no HTTP status). */
export const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503, 529]);

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

export function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status: number }).status;
    if (typeof status === "number") return status;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("overloaded")) return 529;
  const lower = msg.toLowerCase();
  for (const pat of NETWORK_ERROR_PATTERNS) {
    if (lower.includes(pat.toLowerCase())) return 0;
  }
  return null;
}

// --- Cache helpers ---

/**
 * Stamp cache_control on the last tool definition so the entire tools block
 * is cached with a 1-hour TTL.
 */
export function stampToolsCacheControl(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const result = [...tools];
  const last = { ...result[result.length - 1] };
  (last as Record<string, unknown>)["cache_control"] = { type: "ephemeral", ttl: "1h" };
  result[result.length - 1] = last;
  return result;
}

// --- TUI tools ---

export const TUI_TOOLS = new Set([
  "update_modeline",
  "set_theme",
  "style_scene",
  "set_display_resources",
  "set_resource_values",
  "present_choices",
  "present_roll",
  "show_character_sheet",
  "enter_ooc",
  "scene_transition",
  "session_end",
  "context_refresh",
  "scribe",
  "dm_notes",
  "promote_character",
]);

export function isTuiCommand(toolName: string): boolean {
  return TUI_TOOLS.has(toolName);
}

// --- Sleep helper ---

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Core loop ---

interface CreateParams {
  model: string;
  max_tokens: number;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  thinking?: Anthropic.Messages.ThinkingConfigParam;
}

/**
 * Run a unified agent loop: send messages, optionally stream, handle tool_use,
 * loop until end_turn or max rounds. Replaces both agentLoop/agentLoopStreaming
 * inner loops and spawnSubagent's inner loop.
 */
export async function runAgentLoop(
  client: Anthropic,
  systemPrompt: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  config: AgentSessionConfig,
): Promise<AgentSessionResult> {
  const maxToolRounds = config.maxToolRounds ?? 3;
  const shouldStream = config.stream !== false && !!config.onTextDelta;
  const shouldRetry = config.retry ?? false;

  // Resolve thinking config from agent name if not explicitly provided
  const tc = config.thinking ? { param: config.thinking, budgetTokens: 0 } : getThinkingConfig(config.name);
  const effectiveMaxTokens = config.maxTokens + tc.budgetTokens;

  // Apply terse suffix
  let effectiveSystem = systemPrompt;
  if (config.terseSuffix) {
    if (typeof effectiveSystem === "string") {
      effectiveSystem = effectiveSystem + "\n\nIMPORTANT: Respond in the minimum tokens necessary. Be terse.";
    } else {
      effectiveSystem = [...effectiveSystem, { type: "text" as const, text: "\n\nIMPORTANT: Respond in the minimum tokens necessary. Be terse." }];
    }
  }

  // Prepare tools
  let tools: Anthropic.Tool[] | undefined;
  if (config.tools?.length) {
    tools = config.cacheTools ? stampToolsCacheControl(config.tools) : [...config.tools];
  }

  const totalUsage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const tuiCommands: TuiCommand[] = [];
  let fullText = "";
  let truncated = false;

  const workingMessages = [...messages];
  const loopStartIndex = workingMessages.length;
  const tuiToolNames = config.tuiToolNames ?? new Set<string>();

  // Count assistant messages already in conversation so thinking trace round
  // numbers align with assistant message indices in the context dump viewer.
  const priorAssistantCount = messages.filter((m) => m.role === "assistant").length;

  let params: CreateParams = {
    model: config.model,
    max_tokens: effectiveMaxTokens,
    system: effectiveSystem,
    messages: workingMessages,
    thinking: tc.param,
    ...(tools ? { tools } : {}),
  };

  for (let round = 0; round < maxToolRounds; round++) {
    params = {
      model: config.model,
      max_tokens: effectiveMaxTokens,
      system: effectiveSystem,
      messages: workingMessages,
      thinking: tc.param,
      ...(tools ? { tools } : {}),
    };

    let response: Anthropic.Message;

    if (shouldStream) {
      const result = await streamWithRetry(client, params, config, shouldRetry);
      response = result.message;
      accumulateUsage(totalUsage, result.usage);
    } else {
      response = await callWithRetry(client, params, config, shouldRetry);
      accumulateUsage(totalUsage, response.usage);
    }

    // Process content blocks
    let hasToolUse = false;
    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let thinkingText = "";

    for (const block of response.content) {
      // Skip thinking blocks — they must not be sent back in conversation history
      if (block.type === "thinking") {
        thinkingText += block.thinking;
        continue;
      }

      assistantContent.push(block);

      if (block.type === "text") {
        fullText += block.text;
        // In non-streaming mode, fire onTextDelta for the full text block
        if (!shouldStream) {
          config.onTextDelta?.(block.text);
        }
        // In streaming mode, text was already emitted via stream event listener
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        config.onToolStart?.(block.name);

        let result: ToolResult;
        if (config.toolHandler) {
          result = await config.toolHandler(block.name, block.input as Record<string, unknown>);
        } else {
          result = { content: `No handler for tool: ${block.name}`, is_error: true };
        }

        config.onToolEnd?.(block.name, result);

        // Check if this is a TUI command
        if (tuiToolNames.has(block.name)) {
          try {
            const tui = result._tui ?? JSON.parse(result.content);
            tuiCommands.push(tui as TuiCommand);
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

    // Dump thinking blocks (dev mode only)
    if (thinkingText) {
      dumpThinking(config.name, priorAssistantCount + round, thinkingText);
    }

    // Append assistant message
    workingMessages.push({ role: "assistant", content: assistantContent });

    // If no tool use, we're done
    if (!hasToolUse || response.stop_reason === "end_turn") {
      break;
    }

    // Fire-and-forget bail-out: if EVERY tool_use in this round was a TUI
    // tool, skip the next API call. The tool_use/tool_result pair is kept
    // in conversation history so the DM sees a coherent exchange — we just
    // don't burn an API call waiting for an acknowledgment.
    // Only bail out if the DM has already produced text — otherwise the DM
    // called TUI tools before narrating (e.g. dm_notes on first turn) and
    // needs another round to actually speak.
    const toolUseBlocks = assistantContent.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const allTui = toolUseBlocks.length > 0 &&
      toolUseBlocks.every((b) => tuiToolNames.has(b.name));

    if (allTui && fullText.length > 0) {
      // Keep the assistant message as-is (with tool_use blocks) and push
      // tool_results so conversation history has the complete exchange.
      workingMessages.push({ role: "user", content: toolResults });

      dumpContext(config.name, params);

      const roundMessages = workingMessages.slice(loopStartIndex);
      config.onComplete?.(totalUsage);
      return { text: fullText, tuiCommands, usage: totalUsage, truncated, roundMessages };
    }

    // Append tool results as user message
    workingMessages.push({ role: "user", content: toolResults });

    // Check if we're at max rounds
    if (round === maxToolRounds - 1) {
      truncated = true;
    }
  }

  // Final context dump captures the last round's thinking traces
  dumpContext(config.name, params);

  const roundMessages = workingMessages.slice(loopStartIndex);

  config.onComplete?.(totalUsage);
  return { text: fullText, tuiCommands, usage: totalUsage, truncated, roundMessages };
}

// --- Internal retry helpers ---

async function callWithRetry(
  client: Anthropic,
  params: CreateParams,
  config: AgentSessionConfig,
  shouldRetry: boolean,
): Promise<Anthropic.Message> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext(config.name, params);
      return await client.messages.create({
        ...params,
        stream: false,
      });
    } catch (e) {
      if (!shouldRetry) {
        const error = e instanceof Error ? e : new Error(String(e));
        config.onError?.(error);
        throw error;
      }
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
  config: AgentSessionConfig,
  shouldRetry: boolean,
): Promise<{ message: Anthropic.Message; usage: Anthropic.Usage }> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext(config.name, params);
      const stream = client.messages.stream({
        ...params,
      });

      stream.on("text", (delta) => {
        config.onTextDelta?.(delta);
      });

      const message = await stream.finalMessage();
      return { message, usage: message.usage };
    } catch (e) {
      if (!shouldRetry) {
        const error = e instanceof Error ? e : new Error(String(e));
        config.onError?.(error);
        throw error;
      }
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
