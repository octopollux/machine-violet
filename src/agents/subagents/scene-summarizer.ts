import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";

const SYSTEM_PROMPT = `You write campaign log entries from scene transcripts.

Rules:
- One line per significant event. Dense, terse.
- PRESERVE ALL wikilinks from the transcript exactly as written.
- Include mechanical outcomes (HP changes, items gained/lost, alarms set).
- Do not editorialize or add narrative color. Just the facts.
- Format: bullet list, each bullet is one event.`;

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
    TOKEN_LIMITS.SUBAGENT_MEDIUM,
  );
}
