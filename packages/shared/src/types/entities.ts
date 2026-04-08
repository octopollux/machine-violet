export type EntityType =
  | "player"
  | "character"
  | "location"
  | "faction"
  | "lore"
  | "item"
  | "rules"
  | "campaign";

/**
 * Front matter extracted from an entity markdown file.
 *
 * Null semantics (format-spec.md §1.1):
 * - `string` = has a value
 * - `null` = explicitly empty (`**Key:** <none>` on disk)
 * - `undefined` / absent = never set, may need repair
 */
export interface EntityFrontMatter {
  type?: string | null;
  player?: string | null;
  class?: string | null;
  location?: string | null;
  color?: string | null;
  disposition?: string | null;
  additional_names?: string | null;
  display_resources?: string | null;
  theme?: string | null;
  key_color?: string | null;
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
