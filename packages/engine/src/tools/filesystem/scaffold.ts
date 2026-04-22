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
  };
}

/**
 * Directories that should exist at the machine-scope root (~/.machine-violet).
 */
export function machineDirs(homeDir: string): string[] {
  return [join(homeDir, "players")];
}

/**
 * File paths within the machine-scope root (~/.machine-violet).
 * These persist across campaigns.
 */
export function machinePaths(homeDir: string) {
  return {
    player: (name: string) => join(homeDir, "players", `${name}.md`),
    playersDir: join(homeDir, "players"),
  };
}
