/**
 * Auto-generates player choices after DM narration.
 * Fires a Haiku subagent with recent context to suggest 3-4 options.
 * Explicit DM choices (via present_choices tool) take precedence.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ChoiceFrequency } from "../../types/config.js";
import { oneShot } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";

export interface GeneratedChoices {
  choices: string[];
  usage: UsageStats;
}

const SYSTEM_PROMPT = `You generate 3-4 short action choices for a tabletop RPG player.

Given the DM's latest narration, suggest what the player might do next.
Each choice should be a brief action statement (5-10 words).
Include a mix of: cautious/bold, social/physical, creative/direct.
Output ONLY the choices, one per line. No numbering, no explanation.`;

/**
 * Should we auto-generate choices for this turn?
 */
export function shouldGenerateChoices(
  frequency: ChoiceFrequency,
  dmProvidedChoices: boolean,
): boolean {
  // Explicit DM choices always take precedence
  if (dmProvidedChoices) return false;

  switch (frequency) {
    case "always": return true;
    case "often": return Math.random() < 0.7;
    case "rarely": return Math.random() < 0.3;
    case "none": return false;
  }
}

/**
 * Generate player choices from recent DM narration.
 */
export async function generateChoices(
  client: Anthropic,
  recentNarration: string,
  characterName: string,
): Promise<GeneratedChoices> {
  const userMessage = `Character: ${characterName}\n\nDM narration:\n${recentNarration}`;

  const result = await oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    userMessage,
    150,
  );

  const choices = result.text
    .split("\n")
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 4);

  return { choices, usage: result.usage };
}
