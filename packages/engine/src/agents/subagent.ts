import type { ModelId, UsageStats } from "./agent-loop.js";
import { runProviderLoop } from "../providers/agent-loop-bridge.js";
import type { LLMProvider, NormalizedTool, SystemBlock } from "../providers/types.js";

// --- Types ---

export type SubagentVisibility = "silent" | "player_facing";

export interface SubagentConfig {
  /** Subagent name (for logging/activity) */
  name: string;
  /** Model to use */
  model: ModelId;
  /** Silent (DM-only) or player-facing (takes over TUI) */
  visibility: SubagentVisibility;
  /** System prompt for the subagent */
  systemPrompt: string | SystemBlock[];
  /** Max output tokens */
  maxTokens: number;
  /** Tool definitions available to this subagent (optional) */
  tools?: NormalizedTool[];
  /** Tool handler for subagent tool calls (may be async for I/O-bound tools) */
  toolHandler?: (name: string, input: Record<string, unknown>) => { content: string; is_error?: boolean } | Promise<{ content: string; is_error?: boolean }>;
  /** Max tool-use rounds before cutting off */
  maxToolRounds?: number;
  /** Stamp cache hints on tools (1h TTL) */
  cacheTools?: boolean;
}

export interface SubagentResult {
  /** The subagent's final text response */
  text: string;
  /** Usage stats */
  usage: UsageStats;
}

/** Callback for player-facing subagents — receives text as it streams */
export type SubagentStreamCallback = (delta: string) => void;

// --- Cache helpers ---

/**
 * Wrap a plain-text system prompt as a single SystemBlock with cache control.
 * Use for static prompts (loadPrompt output) that are identical across all users.
 */
export function cacheSystemPrompt(text: string): SystemBlock[] {
  return [{ text, cacheControl: { ttl: "1h" } }];
}

// --- Implementation ---

/**
 * Spawn a subagent — a nested Claude conversation with its own context.
 * The parent's context is completely isolated from the subagent.
 *
 * @param provider - LLM provider instance
 * @param config - Subagent configuration
 * @param userMessage - The initial message to the subagent
 * @param onStream - Optional callback for streaming text (player-facing mode)
 */
export async function spawnSubagent(
  provider: LLMProvider,
  config: SubagentConfig,
  userMessage: string,
  onStream?: SubagentStreamCallback,
): Promise<SubagentResult> {
  const isStreaming = config.visibility === "player_facing" && !!onStream;

  const result = await runProviderLoop(provider, config.systemPrompt, [
    { role: "user", content: userMessage },
  ], {
    name: config.name,
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds ?? 3,
    stream: isStreaming,
    tools: config.tools,
    toolHandler: config.toolHandler,
    cacheHints: config.cacheTools ? [{ target: "tools", ttl: "1h" }] : undefined,
    terseSuffix: true,
    onTextDelta: onStream,
  });

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
    },
  };
}

/**
 * Run a simple one-shot subagent (no tools, no streaming).
 * Good for Haiku summarization tasks.
 * System prompt is automatically wrapped with cache control (1h TTL).
 */
export async function oneShot(
  provider: LLMProvider,
  model: ModelId,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 256,
  name = "one_shot",
): Promise<SubagentResult> {
  return spawnSubagent(provider, {
    name,
    model,
    visibility: "silent",
    systemPrompt: cacheSystemPrompt(systemPrompt),
    maxTokens,
  }, userMessage);
}
