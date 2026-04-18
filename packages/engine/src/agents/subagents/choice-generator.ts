/**
 * Auto-generates player choices after DM narration.
 * Fires a Haiku subagent with recent context to suggest 3-6 options.
 * Explicit DM choices (via present_choices tool) take precedence.
 */
import type { LLMProvider } from "../../providers/types.js";
import type { ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

export interface GeneratedChoices extends SubagentResult {
  choices: string[];
}

const SYSTEM_PROMPT = loadPrompt("choice-generator");

/**
 * Should we auto-generate choices for this turn?
 *
 * The "frequency" knob maps to a random probability each turn — configurable
 * from the in-campaign settings menu. "none" is accepted as a legacy alias for
 * "never" so campaigns created before the 5-step scale keep working.
 */
export function shouldGenerateChoices(
  frequency: ChoiceFrequency | "none",
  dmProvidedChoices: boolean,
): boolean {
  // Explicit DM choices always take precedence
  if (dmProvidedChoices) return false;

  switch (frequency) {
    case "always": return true;
    case "often": return Math.random() < 0.75;
    case "sometimes": return Math.random() < 0.5;
    case "rarely": return Math.random() < 0.25;
    case "never": return false;
    case "none": return false; // legacy alias
  }
}

/**
 * Generate player choices from recent DM narration.
 */
export async function generateChoices(
  provider: LLMProvider,
  recentNarration: string,
  characterName: string,
  playerAction?: string,
): Promise<GeneratedChoices> {
  const actionContext = playerAction ? `\n\nPlayer's last action:\n${playerAction}` : "";
  const userMessage = `Character: ${characterName}${actionContext}\n\nDM narration:\n${recentNarration}`;

  const result = await oneShot(
    provider,
    getModel("small"),
    SYSTEM_PROMPT,
    userMessage,
    250,
    "choice-generator",
  );

  const choices = result.text
    .split("\n")
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);

  return { ...result, choices };
}
