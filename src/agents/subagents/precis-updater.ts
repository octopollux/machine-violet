import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";

const SYSTEM_PROMPT = `You append terse summaries to a running scene precis.

Rules:
- One or two sentences maximum.
- Preserve wikilinks.
- Include mechanical state changes (HP, position, items).
- Do not repeat information already in the precis.`;

/**
 * Precis updater subagent.
 * When an exchange drops from the DM's conversation window,
 * this appends a terse summary to the running scene precis.
 *
 * @param client - Anthropic client
 * @param currentPrecis - The current scene precis
 * @param droppedExchange - The exchange that was dropped (formatted as text)
 * @returns Updated precis append text (~20-50 tokens)
 */
export async function updatePrecis(
  client: Anthropic,
  currentPrecis: string,
  droppedExchange: string,
): Promise<SubagentResult> {
  const prompt = `Current precis:\n${currentPrecis}\n\nDropped exchange:\n${droppedExchange}\n\nAppend a terse summary of the dropped exchange to the precis.`;

  return oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    prompt,
    128,
  );
}
