import { join } from "node:path";

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
    join(root, "players"),
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
 */
export function campaignPaths(root: string) {
  return {
    config: join(root, "config.json"),
    log: join(root, "campaign", "log.json"),
    legacyLog: join(root, "campaign", "log.md"),
    sceneSummary: (n: number, slug: string) =>
      join(sceneDir(root, n, slug), "summary.md"),
    character: (name: string) => join(root, "characters", `${name}.md`),
    player: (name: string) => join(root, "players", `${name}.md`),
    location: (name: string) => join(root, "locations", name, "index.md"),
    locationMap: (name: string, mapId: string) =>
      join(root, "locations", name, `${mapId}.json`),
    party: join(root, "characters", "party.md"),
    faction: (name: string) => join(root, "factions", `${name}.md`),
    lore: (name: string) => join(root, "lore", `${name}.md`),
    item: (name: string) => join(root, "items", `${name}.md`),
    rule: (name: string) => join(root, "rules", `${name}.md`),
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
    playerNotes: join(root, "players", "notes.md"),
  };
}
