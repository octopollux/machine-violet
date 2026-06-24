/**
 * Collapse a provider's raw turn messages into the single canonical shape the
 * rest of the engine relies on, so that nothing downstream has to reverse-
 * engineer provider-specific message layouts.
 *
 * Two provider styles produce structurally different turns:
 *
 *  - **Loop-style** (Anthropic, OpenAI Responses / Chat Completions): the bridge
 *    runs the tool loop, so a turn is already a sequence of
 *    `assistant([…, tool_use*])` → `user([tool_result*])` pairs ending in a final
 *    `assistant([text])`. These arrive here already canonical.
 *
 *  - **In-band** (openai-chatgpt / codex): the provider dispatches tools itself
 *    and returns the whole turn as ONE collapsed assistant message mixing
 *    `tool_use` and the final narration, with `toolCalls: []`. The bridge
 *    captures the tool results out of band (they were fed to the model
 *    internally) and hands them here so we can rebuild the canonical pairs with
 *    the *real* results — not the `[no tool result recorded]` stubs orphan-patch
 *    would otherwise synthesize on replay.
 *
 * The returned turn satisfies one invariant for every provider:
 *
 *   1. Tool interactions are `assistant([reasoning?, tool_use*])` →
 *      `user([tool_result*])` pairs.
 *   2. Every `tool_use` id has a matching `tool_result` in the next user message.
 *   3. The turn ends with an `assistant` message whose content is the narration.
 *   4. The narration text appears exactly once.
 *
 * This is the one place turn shape is decided; the engine stores the result
 * verbatim and orphan-patch is demoted to a defensive net for legacy histories.
 */
import type { ContentPart, NormalizedMessage } from "./types.js";
import { ORPHAN_STUB_CONTENT } from "./orphan-patch.js";

/** A tool result captured from a provider that dispatched the tool in-band. */
export interface CapturedToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/**
 * Normalize the raw messages a turn appended into the canonical turn shape.
 *
 * @param rawMessages   Messages the bridge appended during the turn (its
 *                      `workingMessages.slice(loopStartIndex)`).
 * @param inBandResults Tool results captured from an in-band-dispatch provider.
 *                      Empty for loop-style providers.
 * @param fullText      The canonical narration (post regen-collapse) for the turn.
 */
export function normalizeTurn(
  rawMessages: NormalizedMessage[],
  inBandResults: CapturedToolResult[],
  fullText: string,
): NormalizedMessage[] {
  if (inBandResults.length > 0) {
    return splitInBandTurn(rawMessages, inBandResults, fullText);
  }
  return ensureEndsOnAssistant(rawMessages, fullText);
}

/**
 * Rebuild an in-band provider's single collapsed assistant message into the
 * canonical `assistant([reasoning?, tool_use*])` → `user([tool_result*])` →
 * `assistant([text])` form, pairing each `tool_use` with its real captured
 * result. The narration moves to the final assistant message so it appears once.
 */
function splitInBandTurn(
  rawMessages: NormalizedMessage[],
  inBandResults: CapturedToolResult[],
  fullText: string,
): NormalizedMessage[] {
  // Gather all blocks the provider emitted across the turn's assistant messages
  // (in practice a single message for codex). Drop text — `fullText` is the
  // canonical narration; keep tool_use; keep everything else (reasoning,
  // thinking, image blocks) so reasoning continuity round-trips.
  const preserved: ContentPart[] = [];
  const toolUse: Extract<ContentPart, { type: "tool_use" }>[] = [];
  for (const msg of rawMessages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolUse.push(block);
      else if (block.type === "text") continue;
      else preserved.push(block);
    }
  }

  const narration: ContentPart = { type: "text", text: fullText };

  // Defensive: in-band results imply tool calls, but if none were captured as
  // blocks (anomaly), fall back to a single narration message.
  if (toolUse.length === 0) {
    return [{ role: "assistant", content: [...preserved, narration] }];
  }

  const resultById = new Map(inBandResults.map((r) => [r.tool_use_id, r]));
  const toolResults: ContentPart[] = toolUse.map((tu) => {
    const r = resultById.get(tu.id);
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: r?.content ?? ORPHAN_STUB_CONTENT,
      is_error: r?.is_error ?? r === undefined,
    };
  });

  return [
    { role: "assistant", content: [...preserved, ...toolUse] },
    { role: "user", content: toolResults },
    { role: "assistant", content: [narration] },
  ];
}

/**
 * Loop-style turns are already canonical, but a `maxToolRounds` truncation can
 * leave the turn ending on a `user([tool_result])` message with no final
 * assistant. Top it off with the canonical narration so the turn always ends on
 * an assistant message and the engine can decompose it unconditionally.
 */
function ensureEndsOnAssistant(
  rawMessages: NormalizedMessage[],
  fullText: string,
): NormalizedMessage[] {
  if (rawMessages.length === 0) return rawMessages;
  const last = rawMessages[rawMessages.length - 1];
  if (last.role === "assistant") return rawMessages;
  // String content (not an array of blocks) mirrors the pre-existing truncation
  // behavior and avoids emitting an empty text block when `fullText` is "".
  return [...rawMessages, { role: "assistant", content: fullText }];
}
