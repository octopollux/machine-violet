import { describe, it, expect } from "vitest";
import {
  patchOrphanedToolUses,
  reorderAssistantToolUseBlocksLast,
  ORPHAN_STUB_CONTENT,
} from "./orphan-patch.js";
import type { NormalizedMessage } from "./types.js";

/**
 * Unit tests for the orphan-patch helper used by every provider mapper.
 * Provider-specific integration tests (asserting the wiring) live in
 * the per-provider test files.
 */
describe("patchOrphanedToolUses", () => {
  it("passes through clean histories unchanged", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: { sides: 6 } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "4" }] },
      { role: "assistant", content: "you rolled a 4" },
    ];
    expect(patchOrphanedToolUses(messages)).toEqual(messages);
  });

  it("inserts a synthetic user message when no follow-up exists", () => {
    // Reproduces the openai-chatgpt persistence shape that broke replays:
    // assistant tool_use is the trailing message.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "roll_dice", input: {} },
          { type: "tool_use", id: "call_b", name: "scribe", input: {} },
          { type: "text", text: "done" },
        ],
      },
    ];
    const patched = patchOrphanedToolUses(messages);
    expect(patched).toHaveLength(3);
    expect(patched[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_a", content: ORPHAN_STUB_CONTENT, is_error: true },
        { type: "tool_result", tool_use_id: "call_b", content: ORPHAN_STUB_CONTENT, is_error: true },
      ],
    });
  });

  it("merges stubs into an existing follow-up user message with partial coverage", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "roll_dice", input: {} },
          { type: "tool_use", id: "t2", name: "scribe", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ];
    const patched = patchOrphanedToolUses(messages);
    expect(patched).toHaveLength(2);
    expect(patched[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "tool_result", tool_use_id: "t2", content: ORPHAN_STUB_CONTENT, is_error: true },
      ],
    });
  });

  it("inserts a synthetic stub message BEFORE a plain-text follow-up (does not merge)", () => {
    // The OpenAI mappers short-circuit on the first tool_result and drop any
    // sibling text, so merging stubs into a plain-text user turn would silently
    // eat the player's input. Insert a separate stub message instead, leaving
    // the original message byte-identical.
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: {} }],
      },
      { role: "user", content: "next move", ephemeral: true },
    ];
    const patched = patchOrphanedToolUses(messages);
    expect(patched).toHaveLength(3);
    expect(patched[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: ORPHAN_STUB_CONTENT, is_error: true },
      ],
    });
    // Original follow-up preserved verbatim, including ephemeral flag.
    expect(patched[2]).toEqual({ role: "user", content: "next move", ephemeral: true });
  });

  it("preserves an empty-string follow-up user message (no byte erasure)", () => {
    // Defensive — the previous merge logic collapsed empty-string content to []
    // via a falsy check. Insertion path preserves the original message intact.
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: {} }],
      },
      { role: "user", content: "" },
    ];
    const patched = patchOrphanedToolUses(messages);
    expect(patched).toHaveLength(3);
    expect(patched[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: ORPHAN_STUB_CONTENT, is_error: true },
      ],
    });
    expect(patched[2]).toEqual({ role: "user", content: "" });
  });

  it("splits a mixed-content follow-up into tool-result-only + non-result messages", () => {
    // Exotic shape — normal flow never produces a user message that mixes
    // text and tool_result. But if one ever appears (imported history,
    // hand-edit), we must NOT emit a single mixed message to the API: the
    // OpenAI mappers drop sibling text when any tool_result is present.
    // Consolidate all tool_results (existing + stub for any missing IDs)
    // into one message; re-emit non-result blocks as a separate one.
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "a", input: {} },
          { type: "tool_use", id: "t2", name: "b", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "and also" },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ],
      },
    ];
    const patched = patchOrphanedToolUses(messages);
    expect(patched).toHaveLength(3);
    expect(patched[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "tool_result", tool_use_id: "t2", content: ORPHAN_STUB_CONTENT, is_error: true },
      ],
    });
    expect(patched[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "and also" }],
    });
  });

  it("emits stubs in tool_use order (deterministic for cache)", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "z", name: "a", input: {} },
          { type: "tool_use", id: "a", name: "b", input: {} },
          { type: "tool_use", id: "m", name: "c", input: {} },
        ],
      },
    ];
    const patched = patchOrphanedToolUses(messages);
    const ids = (patched[1].content as { tool_use_id?: string }[])
      .map((p) => p.tool_use_id);
    expect(ids).toEqual(["z", "a", "m"]);
  });

  it("is idempotent — re-patching produces the same bytes", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: {} }],
      },
    ];
    const once = patchOrphanedToolUses(messages);
    const twice = patchOrphanedToolUses(once);
    expect(twice).toEqual(once);
  });

  it("heals consecutive orphan-bearing assistant messages independently", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "a", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "b", input: {} }],
      },
    ];
    const patched = patchOrphanedToolUses(messages);
    // asst, synthetic-user, asst, synthetic-user
    expect(patched.map((m) => m.role)).toEqual(["assistant", "user", "assistant", "user"]);
    const ids1 = (patched[1].content as { tool_use_id?: string }[]).map((p) => p.tool_use_id);
    const ids2 = (patched[3].content as { tool_use_id?: string }[]).map((p) => p.tool_use_id);
    expect(ids1).toEqual(["t1"]);
    expect(ids2).toEqual(["t2"]);
  });
});

describe("reorderAssistantToolUseBlocksLast", () => {
  it("passes user messages through unchanged", () => {
    const msg: NormalizedMessage = { role: "user", content: "hi" };
    expect(reorderAssistantToolUseBlocksLast(msg)).toBe(msg);
  });

  it("passes string-content assistant messages through unchanged", () => {
    const msg: NormalizedMessage = { role: "assistant", content: "done" };
    expect(reorderAssistantToolUseBlocksLast(msg)).toBe(msg);
  });

  it("passes canonical [text, tool_use] through unchanged", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Rolling now." },
        { type: "tool_use", id: "t1", name: "roll_dice", input: {} },
      ],
    };
    expect(reorderAssistantToolUseBlocksLast(msg)).toBe(msg);
  });

  it("passes tool_use-only assistant messages through unchanged", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "tool_use", id: "t2", name: "b", input: {} },
      ],
    };
    expect(reorderAssistantToolUseBlocksLast(msg)).toBe(msg);
  });

  it("moves trailing text before tool_use blocks (the openai-chatgpt shape)", () => {
    // Reproduces the shape that triggers Anthropic's
    //   "tool_use ids were found without tool_result blocks immediately after"
    // false-positive.
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "tool_use", id: "t2", name: "b", input: {} },
        { type: "text", text: "Final narration." },
      ],
    };
    expect(reorderAssistantToolUseBlocksLast(msg)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Final narration." },
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "tool_use", id: "t2", name: "b", input: {} },
      ],
    });
  });

  it("preserves relative order within each category (stable)", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "text", text: "second" },
        { type: "tool_use", id: "t2", name: "b", input: {} },
        { type: "text", text: "third" },
      ],
    };
    const out = reorderAssistantToolUseBlocksLast(msg);
    expect(out.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "text", text: "third" },
      { type: "tool_use", id: "t1", name: "a", input: {} },
      { type: "tool_use", id: "t2", name: "b", input: {} },
    ]);
  });

  it("is idempotent", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "a", input: {} },
        { type: "text", text: "done" },
      ],
    };
    const once = reorderAssistantToolUseBlocksLast(msg);
    const twice = reorderAssistantToolUseBlocksLast(once);
    expect(twice).toEqual(once);
  });
});
