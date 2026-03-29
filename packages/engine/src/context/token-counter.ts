import type Anthropic from "@anthropic-ai/sdk";

/**
 * Estimate token count for a string.
 * Uses a simple heuristic: ~4 characters per token on average for English text.
 * This is a rough estimate — the API reports actual counts per response.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a message content block */
export function estimateContentTokens(content: Anthropic.MessageParam["content"]): number {
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  let total = 0;
  for (const block of content) {
    if (block.type === "text") {
      total += estimateTokens(block.text);
    } else if (block.type === "tool_use") {
      total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
    } else if (block.type === "tool_result") {
      const resultBlock = block as Anthropic.ToolResultBlockParam;
      if (typeof resultBlock.content === "string") {
        total += estimateTokens(resultBlock.content);
      } else if (Array.isArray(resultBlock.content)) {
        for (const sub of resultBlock.content) {
          if (sub.type === "text") {
            total += estimateTokens(sub.text);
          }
        }
      }
    }
  }
  return total;
}

/** Estimate total tokens for a message */
export function estimateMessageTokens(msg: Anthropic.MessageParam): number {
  return estimateContentTokens(msg.content) + 4; // role overhead
}
