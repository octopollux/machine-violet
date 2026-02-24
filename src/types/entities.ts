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
  [key: string]: unknown;
}

export interface EntityFile {
  path: string;
  frontMatter: EntityFrontMatter;
  body: string;
  changelog: string[];
}

export interface PromoteCharacterInput {
  name: string;
  file?: string;
  level: "minimal" | "full_sheet";
  context: string;
}
