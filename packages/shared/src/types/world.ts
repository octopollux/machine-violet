import type { CampaignScope } from "./config.js";

/**
 * World file format (.mvworld) — portable campaign seed or world export.
 *
 * A world file is a single JSON file containing world metadata plus optional
 * inline entity content. Campaign seeds and exported worlds are the same format;
 * seeds are just world files with very little data.
 *
 * On-disk format: format-spec.md §10.
 */

/**
 * A decision point baked into a seed — one of the named ways a single
 * `.mvworld` can branch into many possible campaigns. Forks are resolved
 * **entirely at setup time** (never deferred to the DM): player-facing forks
 * are presented to the player, agent-decided forks are rolled/chosen by the
 * setup agent. By the time the DM starts, every fork is collapsed to a single
 * selected option and the unchosen branches are gone — they never enter the
 * DM's context. The selection survives as hard data in `config.fork_selections`.
 */
export interface WorldFork {
  /** Stable kebab-case identifier — the load-bearing "name" of the fork.
   *  Referenced by `config.fork_selections` and by scoped inline content. */
  id: string;
  /** Human label ("Your discipline", "Genre wrapper"). */
  label: string;
  /**
   * Who resolves this fork at setup:
   * - `"player"` — presented to the player as a structured choice.
   * - `"agent"`  — decided by the setup agent (often by rolling the dice tool,
   *   e.g. a "roll or choose" secret). DM-only; never shown to the player.
   */
  chooser: "player" | "agent";
  /** Optional guidance for whoever presents or decides (e.g. "roll to fit the
   *  player's stated preference"). */
  prompt?: string;
  /** The branches. At least two. */
  options: WorldForkOption[];
}

export interface WorldForkOption {
  /** Stable kebab-case identifier — the "name" of the branch. Unique within
   *  the fork. Referenced by scoped inline content. */
  id: string;
  /** Short display name (e.g., "The Iron Circle", "Near-Future Sci-Fi"). */
  name: string;
  /** Longer description. Player-safe when the fork's `chooser` is `"player"`;
   *  otherwise DM-facing guidance for the agent's decision. */
  description: string;
  /**
   * DM-only prose spliced into the campaign's assembled `campaign_detail` when
   * (and only when) this option is the selected branch. This is how a branch's
   * worldbuilding reaches the DM without the unchosen branches tagging along.
   */
  detail?: string;
}

/**
 * @deprecated Legacy player-facing choice group. Superseded by {@link WorldFork}
 * (`chooser: "player"`). Still accepted on disk for back-compat; `normalizeForks`
 * folds any `suboptions` into the unified `forks` list on load.
 */
export interface WorldSuboption {
  /** Group label shown to the player. */
  label: string;
  /** Available choices within this group. */
  choices: WorldSuboptionChoice[];
}

/** @deprecated See {@link WorldSuboption}. */
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
  /**
   * Optional fork scoping. When present, this entity is materialized into the
   * campaign **only if** the named fork resolved to the named option (i.e.
   * `config.fork_selections[fork] === option`). Absent = universal: the entity
   * applies to every variant and is always materialized. Lets a seed ship
   * branch-specific NPCs/locations (e.g. a data-hall that exists only in the
   * sci-fi wrapper) without leaking other branches' content into the campaign.
   */
  appliesWhen?: { fork: string; option: string };
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
  /**
   * Visual style for this seed's generated images — the stem of a `.mvstyle`
   * variant in `prompts/include/Image/` (e.g. `"NoirCinema"`, `"CinematicFilm"`).
   * Drives two things at setup: (1) the setup agent renders the player's
   * character reference sheet in this style (`CinematicFilm` is the fallback
   * when unset), and (2) finalize appends `<!--include:Image.<style>-->` to the
   * campaign's `campaign_detail`, so the DM renders all in-game art in it too —
   * overriding the campaign-wide default `<Image>` via the campaign_detail
   * override slot. Omit to leave the campaign on that default (`CinematicFilm`).
   * A human-graded, one-style-per-seed pairing; the setup agent may still
   * override it.
   */
  image_style?: string;
  /** Intended campaign length. When set, the setup agent uses this instead of
   *  asking the player about scope. Useful for seeds with a clear length (e.g.
   *  a one-shot premise, or a long-form intrigue that doesn't fit short arcs). */
  campaign_scope?: CampaignScope;
  /** DM personality override. */
  dm_personality?: { name: string; prompt_fragment: string };
  /** Calendar display format hint. */
  calendar_display_format?: string;

  // --- DM-only content ---

  /**
   * Rich DM instructions — secrets, pacing, NPC guidance. Never shown to the
   * player. This is the **fork-invariant base**: prose that applies to every
   * possible campaign this seed can produce. Branch-specific worldbuilding does
   * NOT live here — it lives in each fork option's `detail` (see {@link WorldFork})
   * and is spliced in only when that branch is selected. The campaign's final
   * `campaign_detail` is `assembleCampaignDetail(detail, forks, selections)`,
   * optionally followed by setup-agent-supplied detail appended at finalize (a
   * setup-time DM directive the agent was asked to record, e.g. a chosen
   * visual-style include).
   */
  detail?: string;

  /**
   * Setup-agent-only material — the third channel out of a seed (alongside the
   * DM-only `detail` and the forks). `load_world` surfaces it to the setup agent
   * **with includes expanded**, but it is NEVER assembled into the DM's
   * `campaign_detail`. Use it for content the setup agent should act on yet the
   * DM must not see: a scope/pacing variant to present
   * (e.g. `<!--include:Pacing.EndlessCampaigns-->`), chargen hints, alternate
   * hooks to weigh. Semantics are prompt-driven — the setup prompt tells the
   * agent how to use it. The DM-side exclusion is by *omission*:
   * `assembleCampaignDetail` only reads `detail` + selected option `detail`, so
   * nothing here can reach the DM. Includes (and dot-noted variants) resolve
   * here because `renderWorldForAgent` runs `processIncludes` on it.
   */
  setup_detail?: string;

  // --- Forks: the seed's named decision points (resolved at setup) ---

  /** The seed's decision points. See {@link WorldFork}. */
  forks?: WorldFork[];

  /**
   * @deprecated Legacy player-facing choice groups. Folded into `forks`
   * (`chooser: "player"`) by `normalizeForks` on load. New seeds use `forks`.
   */
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
