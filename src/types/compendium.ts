/**
 * Player-facing campaign compendium — a structured knowledge base
 * of everything the player has learned during the campaign.
 *
 * Stored as `campaign/compendium.json`, updated by a Haiku subagent
 * at scene transitions. The subagent reads only the player-facing
 * transcript, so no DM secrets can leak.
 */

export interface CompendiumEntry {
  name: string;
  slug: string;
  aliases?: string[];
  summary: string;
  firstScene: number;
  lastScene: number;
  related: string[];
}

export type CompendiumCategory =
  | "characters"
  | "places"
  | "storyline"
  | "lore"
  | "objectives";

export const COMPENDIUM_CATEGORIES: CompendiumCategory[] = [
  "characters",
  "places",
  "storyline",
  "lore",
  "objectives",
];

export interface Compendium {
  version: 1;
  lastUpdatedScene: number;
  characters: CompendiumEntry[];
  places: CompendiumEntry[];
  storyline: CompendiumEntry[];
  lore: CompendiumEntry[];
  objectives: CompendiumEntry[];
}
