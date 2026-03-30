export type EntityType =
  | "player"
  | "character"
  | "location"
  | "faction"
  | "lore"
  | "rules"
  | "campaign";

/** Front matter extracted from an entity markdown file */
export interface EntityFrontMatter {
  type?: string;
  player?: string;
  class?: string;
  location?: string;
  color?: string;
  disposition?: string;
  additional_names?: string;
  display_resources?: string[];
  theme?: string;
  key_color?: string;
  [key: string]: unknown;
}

export interface EntityFile {
  path: string;
  frontMatter: EntityFrontMatter;
  body: string;
  changelog: string[];
}

// --- Entity Tree (campaign-wide registry) ---

/** A single entry in the campaign entity tree. */
export interface EntityTreeEntry {
  /** Canonical display name (from H1 heading). */
  name: string;
  /** Alternative names (from "Additional Names" front matter). */
  aliases: string[];
  /** Entity type (character, location, faction, lore). */
  type: string;
  /** Relative path from campaign root (e.g. "characters/marta-voss.md"). */
  path: string;
}

/** Campaign-wide entity registry, keyed by slug. */
export type EntityTree = Record<string, EntityTreeEntry>;

export interface PromoteCharacterInput {
  name: string;
  file?: string;
  level: "minimal" | "full_sheet";
  context: string;
}
