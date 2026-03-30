import type { NormalizedMessage } from "../providers/types.js";
import type { ContextConfig } from "@machine-violet/shared/types/config.js";
import { estimateMessageTokens } from "./token-counter.js";

/**
 * An exchange is one player input + the DM's tool calls and response.
 * We track them as pairs for retention logic.
 */
export interface ConversationExchange {
  /** Player's input message */
  user: NormalizedMessage;
  /** DM's response (may include tool_use blocks) */
  assistant: NormalizedMessage;
  /** Tool result messages (if DM used tools) */
  toolResults: NormalizedMessage[];
  /** Estimated total tokens for this exchange */
  estimatedTokens: number;
  /** @deprecated No longer used. Kept for backward compat with persisted state. */
  stubbed?: boolean;
}

/**
 * Manages the conversation window.
 * Tracks exchanges and enforces retention limits.
 */
export class ConversationManager {
  private exchanges: ConversationExchange[] = [];
  private config: ContextConfig;

  constructor(config: ContextConfig) {
    this.config = config;
  }

  /** Add a complete exchange to the conversation */
  addExchange(
    user: NormalizedMessage,
    assistant: NormalizedMessage,
    toolResults: NormalizedMessage[] = [],
  ): DroppedExchange | null {
    const estimatedTokens =
      estimateMessageTokens(user) +
      estimateMessageTokens(assistant) +
      toolResults.reduce((sum, tr) => sum + estimateMessageTokens(tr), 0);

    this.exchanges.push({ user, assistant, toolResults, estimatedTokens });

    // Enforce retention limits
    return this.enforceRetention();
  }

  /** Get messages for the API call (flattened from exchanges) */
  getMessages(): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
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

  /** Remove and return the last exchange (for /retry). Returns null if empty. */
  popLastExchange(): ConversationExchange | null {
    return this.exchanges.pop() ?? null;
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

    // Drop by token count (0 = disabled — scene transitions and pacing nudges
    // handle long scenes; mid-scene token pruning invalidates the prompt cache)
    while (
      this.config.max_conversation_tokens > 0 &&
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
