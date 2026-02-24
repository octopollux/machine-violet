import Anthropic from "@anthropic-ai/sdk";
import type { ModelId, UsageStats } from "./agent-loop.js";
import { dumpContext } from "../config/context-dump.js";

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
  systemPrompt: string;
  /** Max output tokens */
  maxTokens: number;
  /** Tool definitions available to this subagent (optional) */
  tools?: Anthropic.Tool[];
  /** Tool handler for subagent tool calls (may be async for I/O-bound tools) */
  toolHandler?: (name: string, input: Record<string, unknown>) => { content: string; is_error?: boolean } | Promise<{ content: string; is_error?: boolean }>;
  /** Max tool-use rounds before cutting off */
  maxToolRounds?: number;
}

export interface SubagentResult {
  /** The subagent's final text response */
  text: string;
  /** Usage stats */
  usage: UsageStats;
}

/** Callback for player-facing subagents — receives text as it streams */
export type SubagentStreamCallback = (delta: string) => void;

// --- Implementation ---

/**
 * Spawn a subagent — a nested Claude conversation with its own context.
 * The parent's context is completely isolated from the subagent.
 *
 * @param client - Anthropic client instance
 * @param config - Subagent configuration
 * @param userMessage - The initial message to the subagent
 * @param onStream - Optional callback for streaming text (player-facing mode)
 */
export async function spawnSubagent(
  client: Anthropic,
  config: SubagentConfig,
  userMessage: string,
  onStream?: SubagentStreamCallback,
): Promise<SubagentResult> {
  const totalUsage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const maxRounds = config.maxToolRounds ?? 3;

  for (let round = 0; round < maxRounds; round++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.systemPrompt + "\n\nIMPORTANT: Respond in the minimum tokens necessary. Be terse.",
      messages,
      stream: false,
      thinking: { type: "disabled" },
      ...(config.tools?.length ? { tools: config.tools } : {}),
    };

    dumpContext(config.name, params);

    let response: Anthropic.Message;

    if (config.visibility === "player_facing" && onStream) {
      // Stream for player-facing subagents
      const stream = client.messages.stream({
        ...params,
      });

      stream.on("text", (delta) => {
        onStream(delta);
      });

      response = await stream.finalMessage();
    } else {
      // Non-streaming for silent subagents
      response = await client.messages.create(params);
    }

    // Accumulate usage
    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;
    const u = response.usage as Record<string, number>;
    totalUsage.cacheReadTokens += u["cache_read_input_tokens"] ?? 0;
    totalUsage.cacheCreationTokens += u["cache_creation_input_tokens"] ?? 0;

    // Check for tool use
    let hasToolUse = false;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let text = "";

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use" && config.toolHandler) {
        hasToolUse = true;
        const result = await config.toolHandler(block.name, block.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });

    if (!hasToolUse || response.stop_reason === "end_turn") {
      return { text, usage: totalUsage };
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Maxed out tool rounds — return whatever text we accumulated
  const lastAssistant = messages[messages.length - 1];
  let finalText = "";
  if (lastAssistant.role === "assistant" && Array.isArray(lastAssistant.content)) {
    for (const block of lastAssistant.content) {
      if (typeof block === "object" && "type" in block && block.type === "text") {
        finalText += (block as Anthropic.TextBlock).text;
      }
    }
  }

  return { text: finalText, usage: totalUsage };
}

/**
 * Run a simple one-shot subagent (no tools, no streaming).
 * Good for Haiku summarization tasks.
 */
export async function oneShot(
  client: Anthropic,
  model: ModelId,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 256,
): Promise<SubagentResult> {
  return spawnSubagent(client, {
    name: "one_shot",
    model,
    visibility: "silent",
    systemPrompt,
    maxTokens,
  }, userMessage);
}
