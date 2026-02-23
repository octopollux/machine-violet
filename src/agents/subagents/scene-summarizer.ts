import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("scene-summarizer");

/**
 * Scene summarizer subagent.
 * Reads a completed scene transcript and writes a campaign log entry.
 *
 * @param client - Anthropic client
 * @param transcript - The completed scene transcript markdown
 * @returns Campaign log entry (terse, wikilinked)
 */
export async function summarizeScene(
  client: Anthropic,
  transcript: string,
): Promise<SubagentResult> {
  return oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    `Write a campaign log entry for this scene:\n\n${transcript}`,
    TOKEN_LIMITS.DM_RESPONSE,
  );
}
