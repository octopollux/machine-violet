import type Anthropic from "@anthropic-ai/sdk";
import type { ContextConfig } from "../types/config.js";
import { estimateMessageTokens } from "./token-counter.js";

/**
 * An exchange is one player input + the DM's tool calls and response.
 * We track them as pairs for retention logic.
 */
export interface ConversationExchange {
  /** Player's input message */
  user: Anthropic.MessageParam;
  /** DM's response (may include tool_use blocks) */
  assistant: Anthropic.MessageParam;
  /** Tool result messages (if DM used tools) */
  toolResults: Anthropic.MessageParam[];
  /** Estimated total tokens for this exchange */
  estimatedTokens: number;
  /** Has this exchange's tool results been stubbed? */
  stubbed: boolean;
}

/**
 * Manages the conversation window.
 * Tracks exchanges, enforces retention limits, stubs old tool results.
 */
export class ConversationManager {
  private exchanges: ConversationExchange[] = [];
  private config: ContextConfig;

  constructor(config: ContextConfig) {
    this.config = config;
  }

  /** Add a complete exchange to the conversation */
  addExchange(
    user: Anthropic.MessageParam,
    assistant: Anthropic.MessageParam,
    toolResults: Anthropic.MessageParam[] = [],
  ): DroppedExchange | null {
    // Stub tool results immediately so exchange content is stable from the
    // first turn it appears — retroactive stubbing would invalidate cache.
    const stubbedResults = toolResults.map((tr) =>
      tr.role === "user" ? stubToolResult(tr) : tr,
    );

    const estimatedTokens =
      estimateMessageTokens(user) +
      estimateMessageTokens(assistant) +
      stubbedResults.reduce((sum, tr) => sum + estimateMessageTokens(tr), 0);

    this.exchanges.push({ user, assistant, toolResults: stubbedResults, estimatedTokens, stubbed: true });

    // Enforce retention limits
    return this.enforceRetention();
  }

  /** Get messages for the API call (flattened from exchanges) */
  getMessages(): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const ex of this.exchanges) {
      messages.push(ex.user);
      messages.push(...ex.toolResults);
      messages.push(ex.assistant);
    }
    return messages;
  }

  /** Current estimated token count */
  getEstimatedTokens(): number {
    return this.exchanges.reduce((sum, ex) => sum + ex.estimatedTokens, 0);
  }

  /** Number of exchanges in the window */
  get size(): number {
    return this.exchanges.length;
  }

  /** Clear all exchanges (e.g. on scene transition) */
  clear(): void {
    this.exchanges = [];
  }

  /** Get raw exchanges for persistence. */
  getExchanges(): ConversationExchange[] {
    return this.exchanges;
  }

  /**
   * Seed the conversation with previously-persisted exchanges.
   * Token estimates are recomputed; retention is NOT enforced
   * (the exchanges already survived retention when they were live).
   */
  seedExchanges(exchanges: ConversationExchange[]): void {
    for (const ex of exchanges) {
      // Recompute token estimates (they may have been serialized wrong)
      ex.estimatedTokens =
        estimateMessageTokens(ex.user) +
        estimateMessageTokens(ex.assistant) +
        ex.toolResults.reduce((sum, tr) => sum + estimateMessageTokens(tr), 0);
      this.exchanges.push(ex);
    }
  }

  /** Enforce retention_exchanges and max_conversation_tokens */
  private enforceRetention(): DroppedExchange | null {
    let dropped: DroppedExchange | null = null;

    // Drop by exchange count
    while (this.exchanges.length > this.config.retention_exchanges) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- while-loop guarantees non-empty
      const removed = this.exchanges.shift()!;
      dropped = { exchange: removed, reason: "exchange_count" };
    }

    // Drop by token count
    while (
      this.exchanges.length > 1 &&
      this.getEstimatedTokens() > this.config.max_conversation_tokens
    ) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- while-loop guarantees non-empty
      const removed = this.exchanges.shift()!;
      dropped = { exchange: removed, reason: "token_limit" };
    }

    return dropped;
  }
}

export interface DroppedExchange {
  exchange: ConversationExchange;
  reason: "exchange_count" | "token_limit";
}

/** Replace a tool_result message with a terse stub */
function stubToolResult(msg: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof msg.content === "string") return msg;

  const stubbedContent = (msg.content as Anthropic.ToolResultBlockParam[]).map((block) => {
    if (block.type !== "tool_result") return block;
    const original = typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlockParam).text).join(" ")
        : "";

    // Truncate to first line, max 80 chars
    const firstLine = original.split("\n")[0] ?? "";
    const stub = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;

    return {
      ...block,
      content: `[stub] ${stub}`,
    } as Anthropic.ToolResultBlockParam;
  });

  return { role: msg.role, content: stubbedContent };
}
