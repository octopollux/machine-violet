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
    const estimatedTokens =
      estimateMessageTokens(user) +
      estimateMessageTokens(assistant) +
      toolResults.reduce((sum, tr) => sum + estimateMessageTokens(tr), 0);

    this.exchanges.push({ user, assistant, toolResults, estimatedTokens, stubbed: false });

    // Stub old tool results
    this.stubOldToolResults();

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

  /** Serialize exchanges for persistence. All fields are plain JSON-safe. */
  serialize(): SerializedExchange[] {
    return this.exchanges.map((ex) => ({
      user: ex.user,
      assistant: ex.assistant,
      toolResults: ex.toolResults,
      stubbed: ex.stubbed,
    }));
  }

  /** Hydrate a ConversationManager from serialized data */
  static hydrate(data: SerializedExchange[], config: ContextConfig): ConversationManager {
    const mgr = new ConversationManager(config);
    for (const ex of data) {
      const estimatedTokens =
        estimateMessageTokens(ex.user) +
        estimateMessageTokens(ex.assistant) +
        ex.toolResults.reduce((sum, tr) => sum + estimateMessageTokens(tr), 0);
      mgr.exchanges.push({
        user: ex.user,
        assistant: ex.assistant,
        toolResults: ex.toolResults,
        estimatedTokens,
        stubbed: ex.stubbed,
      });
    }
    return mgr;
  }

  /** Replace tool results older than stub_after with one-line stubs */
  private stubOldToolResults(): void {
    const stubAfter = this.config.tool_result_stub_after;
    const cutoff = this.exchanges.length - stubAfter;

    for (let i = 0; i < cutoff; i++) {
      const ex = this.exchanges[i];
      if (ex.stubbed || ex.toolResults.length === 0) continue;

      ex.toolResults = ex.toolResults.map((tr) =>
        tr.role === "user" ? stubToolResult(tr) : tr,
      );
      ex.stubbed = true;

      // Recompute token estimate
      ex.estimatedTokens =
        estimateMessageTokens(ex.user) +
        estimateMessageTokens(ex.assistant) +
        ex.toolResults.reduce((sum, r) => sum + estimateMessageTokens(r), 0);
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

/** Serializable subset of ConversationExchange for persistence */
export interface SerializedExchange {
  user: Anthropic.MessageParam;
  assistant: Anthropic.MessageParam;
  toolResults: Anthropic.MessageParam[];
  stubbed: boolean;
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
