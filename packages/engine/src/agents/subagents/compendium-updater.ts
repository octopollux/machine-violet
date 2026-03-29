import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { Compendium, CompendiumEntry } from "@machine-violet/shared/types/compendium.js";

const SYSTEM_PROMPT = loadPrompt("compendium-updater");

/**
 * Create an empty compendium with default structure.
 */
export function emptyCompendium(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 0,
    characters: [],
    places: [],
    storyline: [],
    lore: [],
    objectives: [],
  };
}

/**
 * Filter a transcript to player-facing lines only.
 * Removes tool result lines (> `tool`: ...) which are mechanical/DM-only.
 */
export function filterPlayerTranscript(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => !line.startsWith("> `"))
    .join("\n");
}

/**
 * Compendium updater subagent.
 * Reads the current compendium and a scene transcript,
 * returns an updated compendium reflecting new player knowledge.
 */
export async function updateCompendium(
  client: Anthropic,
  current: Compendium,
  transcript: string,
  sceneNumber: number,
  aliasContext?: string,
): Promise<{ compendium: Compendium; usage: SubagentResult["usage"] }> {
  const playerTranscript = filterPlayerTranscript(transcript);

  const userMessage = [
    `Scene ${sceneNumber} transcript:\n\n${playerTranscript}`,
    aliasContext ? `\n\n${aliasContext}` : "",
    `\n\nCurrent compendium:\n${JSON.stringify(current, null, 2)}`,
  ].join("");

  const result = await oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    userMessage,
    2048,
    "compendium-updater",
  );

  const compendium = parseCompendiumOutput(result.text, current);
  return { compendium, usage: result.usage };
}

/**
 * Parse compendium JSON from subagent output.
 * Falls back to the original compendium if parsing fails.
 */
export function parseCompendiumOutput(
  text: string,
  fallback: Compendium,
): Compendium {
  try {
    // Strip markdown fences if present
    let json = text.trim();
    if (json.startsWith("```")) {
      const firstNewline = json.indexOf("\n");
      const lastFence = json.lastIndexOf("```");
      if (firstNewline !== -1 && lastFence > firstNewline) {
        json = json.slice(firstNewline + 1, lastFence).trim();
      }
    }

    const parsed = JSON.parse(json) as Compendium;

    // Basic validation: must have the expected category arrays
    if (
      !Array.isArray(parsed.characters) ||
      !Array.isArray(parsed.places) ||
      !Array.isArray(parsed.storyline) ||
      !Array.isArray(parsed.lore) ||
      !Array.isArray(parsed.objectives)
    ) {
      return fallback;
    }

    // Ensure version field
    parsed.version = 1;
    return parsed;
  } catch {
    return fallback;
  }
}

/**
 * Render the compendium as a compact DM-facing summary.
 * One line per category, wikilinked, terse.
 */
export function renderCompendiumForDM(compendium: Compendium): string {
  const lines: string[] = [];

  const renderCategory = (label: string, entries: CompendiumEntry[]) => {
    if (entries.length === 0) return;
    const items = entries.map((e) => {
      // Extract a short descriptor from the summary (first clause)
      const desc = e.summary.split(/[.!?]/)[0]?.trim();
      const shortDesc = desc && desc.length < 60 ? ` (${desc.toLowerCase()})` : "";
      return `[[${e.name}]]${shortDesc}`;
    });
    lines.push(`${label}: ${items.join(", ")}`);
  };

  renderCategory("Characters", compendium.characters);
  renderCategory("Places", compendium.places);
  renderCategory("Storyline", compendium.storyline);
  renderCategory("Lore", compendium.lore);
  renderCategory("Objectives", compendium.objectives);

  return lines.join("\n");
}
