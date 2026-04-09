/**
 * World file format (.mvworld) — portable campaign seed or world export.
 *
 * A world file is a single JSON file containing world metadata plus optional
 * inline entity content. Campaign seeds and exported worlds are the same format;
 * seeds are just world files with very little data.
 *
 * On-disk format: format-spec.md §10.
 */

/** A player-facing suboption group (e.g., "Your starting faction"). */
export interface WorldSuboption {
  /** Group label shown to the player. */
  label: string;
  /** Available choices within this group. */
  choices: WorldSuboptionChoice[];
}

export interface WorldSuboptionChoice {
  /** Short choice name (e.g., "The Iron Circle"). */
  name: string;
  /** Longer description of what this choice means. */
  description: string;
}

/** An inline entity in a world file. */
export interface WorldEntity {
  /** Display title (H1 heading in the entity markdown). */
  title: string;
  /** Front matter key-value pairs. */
  frontMatter: Record<string, string | string[] | null>;
  /** Markdown body (below the front matter + title). */
  body: string;
}

/** Calendar state carried in a world file (stripped of alarms). */
export interface WorldCalendar {
  /** Current time in minutes from epoch. */
  current: number;
  /** Narrative label for time zero. */
  epoch: string;
  /** Freeform display format hint. */
  display_format: string;
}

/**
 * The .mvworld file schema.
 *
 * Required fields: format, version, name, summary, genres.
 * Everything else is optional — a minimal seed has just the identity fields.
 */
export interface WorldFile {
  /** Must be "machine-violet-world". */
  format: "machine-violet-world";
  /** Schema version. Currently 1. */
  version: 1;

  // --- Identity (required) ---

  /** World/campaign name. */
  name: string;
  /** One-sentence hook or premise. */
  summary: string;
  /** Genre tags for filtering (e.g., ["fantasy", "horror"]). */
  genres: string[];

  // --- Optional campaign config fields ---

  /** Short description shown alongside the summary. */
  description?: string;
  /** Game system slug (e.g., "dnd-5e"). */
  system?: string;
  /** Mood (e.g., "gritty", "lighthearted"). */
  mood?: string;
  /** Difficulty (e.g., "hard", "easy"). */
  difficulty?: string;
  /** DM personality override. */
  dm_personality?: { name: string; prompt_fragment: string };
  /** Calendar display format hint. */
  calendar_display_format?: string;

  // --- DM-only content ---

  /** Rich DM instructions — secrets, pacing, NPC guidance. Never shown to the player. */
  detail?: string;

  // --- Player-facing choices ---

  /** Structured suboption groups (e.g., starting faction, setting variant). */
  suboptions?: WorldSuboption[];

  // --- Inline content (optional — empty for seeds, rich for exports) ---

  /** Inline entities keyed by category, then slug. */
  entities?: {
    characters?: Record<string, WorldEntity>;
    locations?: Record<string, WorldEntity>;
    factions?: Record<string, WorldEntity>;
    items?: Record<string, WorldEntity>;
    lore?: Record<string, WorldEntity>;
  };

  /** Maps keyed by map ID (same schema as state/maps.json values). */
  maps?: Record<string, unknown>;

  /** Rule card content keyed by slug. */
  rules?: Record<string, string>;

  /** Calendar state (world time, no alarms). */
  calendar?: WorldCalendar;
}
