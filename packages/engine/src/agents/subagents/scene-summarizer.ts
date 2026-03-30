import type { LLMProvider } from "../../providers/types.js";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("scene-summarizer");

const MINI_DELIMITER = "---MINI---";

/**
 * Extended result from scene summarizer — includes both full and mini summaries.
 */
export interface SceneSummaryResult extends SubagentResult {
  /** Full bullet-list summary */
  full: string;
  /** Dense one-liner (max 128 chars, preserving critical wikilinks) */
  mini: string;
}

/**
 * Scene summarizer subagent.
 * Reads a completed scene transcript and writes both a full and mini campaign log entry.
 *
 * @param client - Anthropic client
 * @param transcript - The completed scene transcript markdown
 * @returns Campaign log entry with full and mini summaries
 */
export async function summarizeScene(
  provider: LLMProvider,
  transcript: string,
  aliasContext?: string,
): Promise<SceneSummaryResult> {
  const result = await oneShot(
    provider,
    getModel("small"),
    SYSTEM_PROMPT,
    `Write a campaign log entry for this scene:\n\n${transcript}${aliasContext ?? ""}`,
    TOKEN_LIMITS.DM_RESPONSE,
    "scene-summarizer",
  );

  const { full, mini } = parseSummaryOutput(result.text);

  return {
    ...result,
    full,
    mini,
  };
}

/**
 * Parse the summarizer output into full and mini parts.
 * Expected format: bullet list, then `---MINI---`, then a single sentence.
 * Fallback: if delimiter is missing, mini = first bullet text.
 */
export function parseSummaryOutput(text: string): { full: string; mini: string } {
  const delimIdx = text.indexOf(MINI_DELIMITER);

  if (delimIdx === -1) {
    // Fallback: no delimiter found
    const lines = text.trim().split("\n");
    const firstBullet = lines.find((l) => l.trim().startsWith("- "));
    const mini = firstBullet?.replace(/^-\s*/, "").trim() ?? lines[0]?.trim() ?? "";
    return { full: text.trim(), mini };
  }

  const full = text.slice(0, delimIdx).trim();
  const mini = text.slice(delimIdx + MINI_DELIMITER.length).trim();

  return { full, mini };
}
