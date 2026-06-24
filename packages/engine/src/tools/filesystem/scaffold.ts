import { join } from "node:path";
import { slugify } from "../../utils/slug.js";

/**
 * The deterministic campaign directory structure.
 * Returns the list of directories that should exist.
 */
export function campaignDirs(root: string): string[] {
  return [
    root,
    join(root, "campaign"),
    join(root, "campaign", "scenes"),
    join(root, "campaign", "session-recaps"),
    join(root, "campaign", "images"),
    join(root, "characters"),
    join(root, "locations"),
    join(root, "factions"),
    join(root, "lore"),
    join(root, "items"),
    join(root, "rules"),
    join(root, "state"),
  ];
}

/**
 * Scene directory path from a scene number and slug.
 * e.g., sceneDir(root, 1, "tavern-meeting") → ".../campaign/scenes/001-tavern-meeting"
 */
export function sceneDir(
  root: string,
  number: number,
  slug: string,
): string {
  const padded = String(number).padStart(3, "0");
  return join(root, "campaign", "scenes", `${padded}-${slug}`);
}

/**
 * Standard file paths within a campaign.
 *
 * The entity-type helpers (`character`, `location`, `faction`, `lore`, `item`,
 * `rule`) defensively slugify the name via the canonical `slugify` in
 * `utils/slug.ts`. Callers can pass either a raw display name ("Janey Bruce")
 * or a slug already produced by that same canonical slugify ("janey-bruce")
 * and land on the same path. Ad-hoc slugs produced by other transformations
 * are NOT guaranteed to round-trip — e.g. a hand-written "the-goblin-caves"
 * stays "the-goblin-caves" here (article-stripping only triggers on whitespace)
 * and would not collide with the canonical "goblin-caves". Everything
 * campaign-internal routes through `slugify()`, so this only matters if a
 * caller is constructing slugs manually — don't.
 *
 * This is belt-and-suspenders against a class of bugs where a DM-side
 * codepath reads/writes an entity file under its display name while a
 * sibling path (setup, scribe) uses the slug — producing two parallel files
 * for the same entity.
 */
export function campaignPaths(root: string) {
  return {
    config: join(root, "config.json"),
    log: join(root, "campaign", "log.json"),
    legacyLog: join(root, "campaign", "log.md"),
    sceneSummary: (n: number, slug: string) =>
      join(sceneDir(root, n, slug), "summary.md"),
    character: (name: string) => join(root, "characters", `${slugify(name)}.md`),
    location: (name: string) => join(root, "locations", slugify(name), "index.md"),
    locationMap: (name: string, mapId: string) =>
      join(root, "locations", slugify(name), `${mapId}.json`),
    party: join(root, "characters", "party.md"),
    faction: (name: string) => join(root, "factions", `${slugify(name)}.md`),
    lore: (name: string) => join(root, "lore", `${slugify(name)}.md`),
    item: (name: string) => join(root, "items", `${slugify(name)}.md`),
    rule: (name: string) => join(root, "rules", `${slugify(name)}.md`),
    sessionRecap: (n: number) =>
      join(root, "campaign", "session-recaps", `session-${String(n).padStart(3, "0")}.md`),
    sessionRecapNarrative: (n: number) =>
      join(root, "campaign", "session-recaps", `session-${String(n).padStart(3, "0")}-narrative.md`),
    sceneTranscript: (n: number, slug: string) =>
      join(sceneDir(root, n, slug), "transcript.md"),
    sceneDmNotes: (n: number, slug: string) =>
      join(sceneDir(root, n, slug), "dm-notes.md"),
    dmNotes: join(root, "campaign", "dm-notes.md"),
    compendium: join(root, "campaign", "compendium.json"),
    playerNotes: join(root, "campaign", "player-notes.md"),
    imagesDir: join(root, "campaign", "images"),
    /**
     * Path for a generated image file (PNG by convention). Caller picks
     * the basename — see image-handler.ts for the naming scheme that
     * encodes intent + scene + timestamp.
     */
    image: (filename: string) => join(root, "campaign", "images", filename),
    /**
     * Confirmed character portrait, sitting next to the character's `.md`
     * file. Setup-agent writes to this path after the player accepts a
     * draft from the show-and-confirm loop.
     *
     * This is a **stable pointer**: it always holds the *current* look. When
     * the DM revises a portrait mid-campaign (`commitPortraitRevision`), the
     * prior version is archived under `portrait-history/` and this path is
     * overwritten — so every reader stays on one path and always gets newest.
     */
    characterPortrait: (name: string) => join(root, "characters", `${slugify(name)}-portrait.png`),
    /**
     * Archive of superseded portrait versions. `commitPortraitRevision` copies
     * the outgoing current portrait here (numbered, highest = most recent)
     * before overwriting `characterPortrait` — old portraits are never
     * destroyed, but only the current pointer is ever read back into context.
     */
    portraitHistoryDir: join(root, "characters", "portrait-history"),
    characterPortraitArchive: (name: string, version: number) =>
      join(root, "characters", "portrait-history", `${slugify(name)}-${String(version).padStart(3, "0")}.png`),
  };
}

/**
 * Directories that should exist at the machine-scope root (~/.machine-violet).
 */
export function machineDirs(homeDir: string): string[] {
  return [join(homeDir, "players"), join(homeDir, "worlds"), join(homeDir, "personalities")];
}

/**
 * File paths within the machine-scope root (~/.machine-violet).
 * These persist across campaigns.
 */
export function machinePaths(homeDir: string) {
  return {
    player: (name: string) => join(homeDir, "players", `${name}.md`),
    playersDir: join(homeDir, "players"),
    worldsDir: join(homeDir, "worlds"),
    personalitiesDir: join(homeDir, "personalities"),
  };
}
