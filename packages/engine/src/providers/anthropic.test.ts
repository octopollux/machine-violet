import { describe, it, expect } from "vitest";
import { toAnthropicParams } from "./anthropic.js";
import type { ChatParams, NormalizedMessage } from "./types.js";

/**
 * Exercise the BP4 (messages) cache-stamp logic — the single most important
 * cache decision for the DM loop. Stamping on an ephemeral message poisons
 * the cache for the next player turn; these tests guard against that
 * regression specifically.
 */

function baseParams(overrides?: Partial<ChatParams>): ChatParams {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    messages: [],
    maxTokens: 1024,
    cacheHints: [{ target: "messages" }],
    ...overrides,
  };
}

/**
 * Extract cache_control presence per message index from the mapped Anthropic
 * messages — returns an array where true = stamped, false = not stamped.
 */
function stampedIndexes(mapped: ReturnType<typeof toAnthropicParams>["messages"]): boolean[] {
  return mapped.map((m) => {
    if (typeof m.content === "string") return false;
    return (m.content as Record<string, unknown>[]).some((b) => "cache_control" in b);
  });
}

describe("toAnthropicParams: messages cache stamp (BP4)", () => {
  it("stamps the last message when nothing is ephemeral", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what is 2+2?" },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false, true]);
  });

  it("skips past an ephemeral last message and stamps the previous one", () => {
    // Fresh-turn shape: history ends at asst_N-1, new user has a volatile
    // <context> preamble. BP4 must land on asst_N-1 so cache prefix stays
    // valid on the next turn (when the user message bytes will be stripped).
    const messages: NormalizedMessage[] = [
      { role: "user", content: "turn 1 input" },
      { role: "assistant", content: "turn 1 response" },
      { role: "user", content: "<context>...</context>\n\nturn 2 input", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, true, false]);
  });

  it("skips multiple trailing ephemeral messages", () => {
    // Defensive — unlikely today, but the loop should keep skipping back.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "ephemeral 1", ephemeral: true },
      { role: "user", content: "ephemeral 2", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, true, false, false]);
  });

  it("within-round (rounds 2+): stamps on the latest tool_result", () => {
    // Mid-loop shape: the preamble-bearing user is still in history and
    // marked ephemeral, but the tail is the stored tool_result from the
    // previous round. That tail is stable and should be stamped.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "prior turn" },
      { role: "assistant", content: "prior response" },
      { role: "user", content: "<context>...</context>\n\nturn input", ephemeral: true },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: { sides: 20 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "17" }],
      },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false, false, false, true]);
  });

  it("does not stamp when no cacheHint for messages is requested", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages, cacheHints: [] }));
    expect(stampedIndexes(out.messages)).toEqual([false]);
  });

  it("stamps nothing when every message is ephemeral (degenerate)", () => {
    // Pathological input: don't stamp anything rather than poison cache.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "a", ephemeral: true },
      { role: "user", content: "b", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false]);
  });
});
