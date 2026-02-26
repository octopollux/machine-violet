import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadTemplate } from "../../prompts/load-prompt.js";

/**
 * Narrative recap subagent.
 * Takes a bullet-point session recap and produces a short narrative paragraph
 * for display in the "Previously on..." modal.
 *
 * @param client - Anthropic client
 * @param bulletRecap - The bullet-point session recap markdown
 * @param campaignName - Campaign name for the "Last time on..." opener
 * @returns Narrative prose recap (~100 words)
 */
export async function generateNarrativeRecap(
  client: Anthropic,
  bulletRecap: string,
  campaignName: string,
): Promise<SubagentResult> {
  const systemPrompt = loadTemplate("narrative-recap", { campaign_name: campaignName });
  return oneShot(
    client,
    getModel("small"),
    systemPrompt,
    `Convert this session recap into narrative prose:\n\n${bulletRecap}`,
    TOKEN_LIMITS.SUBAGENT_SMALL,
    "narrative-recap",
  );
}
