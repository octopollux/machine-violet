/**
 * Heal conversation history with orphaned `tool_use` blocks by inserting
 * synthetic `tool_result` stubs.
 *
 * Provider APIs (Anthropic, OpenAI Responses, OpenAI Chat Completions) all
 * require every assistant `tool_use` / `function_call` to be matched by a
 * corresponding `tool_result` / `function_call_output` in the next user
 * message. Real histories occasionally violate this — an aborted turn, a
 * crash between tool dispatch and tool_result persist, or a provider
 * (e.g. openai-chatgpt) that owns tool dispatch in-band and persists only
 * the assistant's tool_use blocks. Without healing, every subsequent turn
 * 400s and the campaign becomes unrecoverable.
 *
 * The patch is deterministic: same input → same output, byte-for-byte. The
 * stub content is a fixed string, stubs are emitted in the same order as
 * the orphaned ids, and merged into an existing user message when one
 * already follows (rather than inserting a duplicate). That keeps prompt
 * caches valid — Anthropic BP4 stamping picks a stable tail, and OpenAI's
 * automatic prefix cache sees identical bytes on the next turn.
 */
import type { ContentPart, NormalizedMessage } from "./types.js";

/** Visible in stub tool_result content. Stable so caches stay valid. */
export const ORPHAN_STUB_CONTENT = "[no tool result recorded]";

/**
 * Reorder content blocks within an assistant message so that `tool_use` blocks
 * appear last. Anthropic's `/v1/messages` validator requires this: an
 * assistant message of shape `[tool_use, text]` is rejected with
 * "tool_use ids were found without tool_result blocks immediately after",
 * even when the next user message contains a perfectly-matched tool_result.
 * The validator treats trailing text after tool_use as "the assistant kept
 * talking after the call" and gives up looking for results.
 *
 * Stored history from the openai-chatgpt provider has exactly this shape
 * (it appends the final committed text after tool_use blocks). Reordering
 * blocks to the canonical [text…, tool_use…] form heals replay.
 *
 * Stable within each category — relative order of text blocks is preserved,
 * relative order of tool_use blocks is preserved. Deterministic for cache.
 */
export function reorderAssistantToolUseBlocksLast(msg: NormalizedMessage): NormalizedMessage {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

  // Cheap fast-path: only reorder if a tool_use is followed by a non-tool_use.
  let needsReorder = false;
  let sawToolUse = false;
  for (const part of msg.content) {
    if (part.type === "tool_use") {
      sawToolUse = true;
    } else if (sawToolUse) {
      needsReorder = true;
      break;
    }
  }
  if (!needsReorder) return msg;

  const nonToolUse: ContentPart[] = [];
  const toolUse: ContentPart[] = [];
  for (const part of msg.content) {
    if (part.type === "tool_use") toolUse.push(part);
    else nonToolUse.push(part);
  }
  return { ...msg, content: [...nonToolUse, ...toolUse] };
}

export function patchOrphanedToolUses(messages: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds: string[] = [];
    for (const part of msg.content) {
      if (part.type === "tool_use") toolUseIds.push(part.id);
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const covered = new Set<string>();
    if (next?.role === "user" && Array.isArray(next.content)) {
      for (const part of next.content) {
        if (part.type === "tool_result") covered.add(part.tool_use_id);
      }
    }
    const missing = toolUseIds.filter((id) => !covered.has(id));
    if (missing.length === 0) continue;

    const stubs: ContentPart[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: ORPHAN_STUB_CONTENT,
      is_error: true,
    }));

    if (next?.role === "user") {
      // Merge stubs into the existing follow-up user message so we don't
      // emit two consecutive user messages. String content gets promoted
      // to a block array first.
      const baseBlocks: ContentPart[] = Array.isArray(next.content)
        ? next.content
        : next.content
          ? [{ type: "text", text: next.content }]
          : [];
      out.push({ role: "user", content: [...baseBlocks, ...stubs], ephemeral: next.ephemeral });
      i++; // consume the original next message; we just emitted its merged form
    } else {
      // No following user message at all (or it's an assistant — also broken
      // shape). Insert a synthetic user message; subsequent iterations will
      // re-process whatever comes next in the original list.
      out.push({ role: "user", content: stubs });
    }
  }
  return out;
}
