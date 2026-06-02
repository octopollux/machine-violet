/**
 * Declared entity schemas.
 *
 * These are the *minimal* canonical shape for each file-backed entity type.
 * Everything else is observational — see the entity store's drift scanner
 * and `describe_entity_type`, which surface fields that show up on disk but
 * aren't declared here.
 *
 * Start small. Promote a field from "observed" to "declared" only when the
 * data is consistent enough that we want agents to rely on it.
 */

/** Storage layout for an entity type on disk. */
export interface EntityStorage {
  /** Top-level directory under the campaign root (e.g. "characters"). */
  dir: string;
  /**
   * True when each entity lives under `<dir>/<slug>/index.md` instead of a
   * flat `<dir>/<slug>.md`. Only locations use this today.
   */
  subdirs: boolean;
  format: "markdown+frontmatter";
}

/** Where a field is read from when materializing an entity record. */
export type FieldSource =
  | "h1"            // the markdown H1 heading
  | "frontmatter"   // a **Key:** Value line in the front matter
  | "body";         // a ## section in the body

export interface SchemaField {
  required: boolean;
  kind: "string" | "string[]" | "wikilink" | "wikilink[]";
  source: FieldSource;
  /** Free-form description for `describe_entity_type` output. */
  description?: string;
}

export interface EntitySchema {
  type: FileBackedEntityType;
  /**
   * Bumped when a declared field is added/removed/retyped. Not bumped for
   * data tweaks — the data isn't versioned, only the contract is.
   */
  version: string;
  storage: EntityStorage;
  fields: Record<string, SchemaField>;
  conventions: string[];
}

/** Entity types that have on-disk files we own with this rework. */
export type FileBackedEntityType =
  | "character"
  | "location"
  | "faction"
  | "lore"
  | "item";

export const FILE_BACKED_ENTITY_TYPES: readonly FileBackedEntityType[] = [
  "character",
  "location",
  "faction",
  "lore",
  "item",
] as const;

// --- Shared bits ---

const SHARED_CONVENTIONS = [
  "The H1 heading is the canonical display name. Filename slug is derived from it via slugify().",
  "Wikilinks use markdown link syntax: [Display](../type/slug.md). Targets are bidirectional and tracked across the campaign.",
  "Changelog entries live in a `## Changelog` section as `- **Scene NNN**: note`.",
  "Unknown front-matter keys are preserved on round-trip but flagged as drift.",
];

const DISPLAY_NAME: SchemaField = {
  required: true,
  kind: "string",
  source: "h1",
  description: "Canonical display name (the H1 heading).",
};

// Schema field names match on-disk keys exactly so agents can write what
// they read. `EntityRecord.aliases` is a parsed convenience on top of this
// raw string.
const ADDITIONAL_NAMES: SchemaField = {
  required: false,
  kind: "string",
  source: "frontmatter",
  description: "Comma-separated alternative names (e.g. \"Pale One, The Pale\"). Parsed into `EntityRecord.aliases` on read.",
};

const TYPE_CATEGORY: SchemaField = {
  required: true,
  kind: "string",
  source: "frontmatter",
  description: "Entity category marker (\"character\", \"location\", \"faction\", \"lore\", or \"item\"). Set automatically by the store from the on-disk directory; do not override.",
};

const TYPE_CHARACTER_ROLE: SchemaField = {
  required: true,
  kind: "string",
  source: "frontmatter",
  description: "Character role marker: \"PC\" for a player character, \"NPC\" for a named non-player character, or \"character\" (generic). Documentary — the functional PC roster lives in config.json; use swap_pc to change who is actually played. The store accepts these role values but will reject any attempt to relabel the sheet as a different entity category (e.g. \"location\").",
};

// --- Per-type schemas ---

export const CHARACTER_SCHEMA: EntitySchema = {
  type: "character",
  version: "0.1",
  storage: { dir: "characters", subdirs: false, format: "markdown+frontmatter" },
  fields: {
    displayName: DISPLAY_NAME,
    additional_names: ADDITIONAL_NAMES,
    type: TYPE_CHARACTER_ROLE,
    location: {
      required: false,
      kind: "wikilink",
      source: "frontmatter",
      description: "Where this character currently is. Wikilink to a location.",
    },
  },
  conventions: [
    ...SHARED_CONVENTIONS,
    "PCs and named NPCs both live here. The `type` field carries the role — \"PC\", \"NPC\", or \"character\" — and is editable via the `entity` tool. It's documentary: the functional PC roster is config.json's players[]; use swap_pc to actually hand off control. The store still blocks relabeling a sheet as a different entity category.",
    "Promoted character sheets follow `promote_character`'s sheet format under `## Stats`/`## Abilities`.",
  ],
};

export const LOCATION_SCHEMA: EntitySchema = {
  type: "location",
  version: "0.1",
  storage: { dir: "locations", subdirs: true, format: "markdown+frontmatter" },
  fields: {
    displayName: DISPLAY_NAME,
    additional_names: ADDITIONAL_NAMES,
    type: TYPE_CATEGORY,
  },
  conventions: [
    ...SHARED_CONVENTIONS,
    "Locations are the only entity type stored in subdirectories — `locations/<slug>/index.md`.",
    "Map JSONs live alongside `index.md` as `locations/<slug>/<map-id>.json`. Map editing goes through `map`/`map_entity` tools, not this surface.",
  ],
};

export const FACTION_SCHEMA: EntitySchema = {
  type: "faction",
  version: "0.1",
  storage: { dir: "factions", subdirs: false, format: "markdown+frontmatter" },
  fields: {
    displayName: DISPLAY_NAME,
    additional_names: ADDITIONAL_NAMES,
    type: TYPE_CATEGORY,
  },
  conventions: [
    ...SHARED_CONVENTIONS,
    "Factions usually have `## Goals` and `## Members` sections in the body. Not required, but conventional.",
  ],
};

export const LORE_SCHEMA: EntitySchema = {
  type: "lore",
  version: "0.1",
  storage: { dir: "lore", subdirs: false, format: "markdown+frontmatter" },
  fields: {
    displayName: DISPLAY_NAME,
    additional_names: ADDITIONAL_NAMES,
    type: TYPE_CATEGORY,
  },
  conventions: [
    ...SHARED_CONVENTIONS,
    "Lore is the catch-all for world facts, history, myths, creatures-as-flavor. When in doubt about where an entity belongs, lore is the safer default.",
  ],
};

export const ITEM_SCHEMA: EntitySchema = {
  type: "item",
  version: "0.1",
  storage: { dir: "items", subdirs: false, format: "markdown+frontmatter" },
  fields: {
    displayName: DISPLAY_NAME,
    additional_names: ADDITIONAL_NAMES,
    type: TYPE_CATEGORY,
  },
  conventions: [
    ...SHARED_CONVENTIONS,
    "Items here are notable named/unique items the campaign tracks. Generic loot lives in character inventories, not as separate entity files.",
  ],
};

const SCHEMAS: Record<FileBackedEntityType, EntitySchema> = {
  character: CHARACTER_SCHEMA,
  location: LOCATION_SCHEMA,
  faction: FACTION_SCHEMA,
  lore: LORE_SCHEMA,
  item: ITEM_SCHEMA,
};

export function getEntitySchema(type: FileBackedEntityType): EntitySchema {
  return SCHEMAS[type];
}

export function isFileBackedEntityType(type: string): type is FileBackedEntityType {
  return (FILE_BACKED_ENTITY_TYPES as readonly string[]).includes(type);
}
