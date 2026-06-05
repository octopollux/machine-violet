import type { FileIO } from "./scene-manager.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignConfig } from "./setup-agent.js";
import { campaignDirs, campaignPaths, machineDirs, machinePaths } from "../tools/filesystem/index.js";
import { serializeEntity, parseFrontMatter, extractSection } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { slugify } from "../utils/slug.js";
import { findSystem, readBundledRuleCard } from "../config/systems.js";
import { processingPaths } from "../config/processing-paths.js";
import { loadWorldBySlug } from "../config/world-loader.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";

/**
 * Build the entire campaign directory from setup results.
 * This is Step 3 from game-initialization.md — mostly T1 file creation.
 */
export async function buildCampaignWorld(
  campaignsDir: string,
  result: SetupResult,
  fileIO: FileIO,
  homeDir?: string,
): Promise<string> {
  // Generate campaign directory name (slug), ensuring uniqueness
  const baseSlug = slugify(result.campaignName);
  let slug = baseSlug;
  let suffix = 2;
  while (await fileIO.exists(`${campaignsDir}/${slug}`)) {
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }
  const root = `${campaignsDir}/${slug}`;

  // 1. Create campaign directory structure
  const dirs = campaignDirs(root);
  for (const dir of dirs) {
    await fileIO.mkdir(norm(dir));
  }

  // 2. Write config.json
  const config = buildCampaignConfig(result);
  const paths = campaignPaths(root);
  await fileIO.writeFile(
    norm(paths.config),
    JSON.stringify(config, null, 2) + "\n",
  );

  // 3. Write character file
  const charPath = norm(paths.character(slugify(result.characterName)));
  let charBody = result.characterDescription || "A newly created character. Their story unfolds through play.";
  if (result.characterDetails) {
    charBody += "\n\n## Character Details\n" + result.characterDetails;
  }
  const charContent = serializeEntity(
    result.characterName,
    {
      type: "PC",
      player: result.playerName,
      display_resources: "HP",
      theme_color: result.themeColor,
    },
    charBody,
    [],
  );
  await fileIO.writeFile(charPath, charContent);

  // 4. Write party file
  const charSlug = slugify(result.characterName);
  const partyContent = serializeEntity(
    "The Party",
    { type: "Party" },
    `## Members\n- [[${charSlug}]]\n\n## Shared Resources\n(None yet)`,
    [],
  );
  await fileIO.writeFile(norm(paths.party), partyContent);

  // 5. Write player file (machine-scope — persists across campaigns)
  if (homeDir) {
    for (const dir of machineDirs(homeDir)) {
      await fileIO.mkdir(norm(dir));
    }
    const playerSlug = slugify(result.playerName);
    const playerPath = norm(machinePaths(homeDir).player(playerSlug));
    if (!(await fileIO.exists(playerPath))) {
      const fm: Record<string, unknown> = { type: "Player" };
      if (result.ageGroup) fm.age_group = result.ageGroup;
      const body = buildInitialContentBoundaries(result.ageGroup, result.contentPreferences);
      const playerContent = serializeEntity(result.playerName, fm, body, []);
      await fileIO.writeFile(playerPath, playerContent);
    } else {
      // Returning player — update with any newly captured metadata
      await updateReturningPlayer(playerPath, result, fileIO);
    }
  }

  // 6. Write campaign log (empty JSON)
  const logPath = norm(paths.log);
  const logContent = JSON.stringify(
    { campaignName: result.campaignName, entries: [] },
    null,
    2,
  );
  await fileIO.writeFile(logPath, logContent);

  // 7. Write starting location (placeholder — DM renames via Scribe once it
  // has named the opening locale; see scribe.md "Placeholder entities").
  const locationSlug = "starting-location";
  const locationPath = norm(paths.location(locationSlug));
  const locationDir = locationPath.replace(/\/index\.md$/, "");
  await fileIO.mkdir(locationDir);
  const locationContent = serializeEntity(
    "Starting Location",
    { type: "Location", placeholder: true },
    "_Placeholder — rename via `rename_entity` once the opening locale has a real name in the fiction._",
    [],
  );
  await fileIO.writeFile(locationPath, locationContent);

  // 8. Copy bundled rule card to ~/.machine-violet/systems/<slug>/ if available
  if (homeDir && result.system) {
    const system = findSystem(result.system);
    if (system?.hasRuleCard) {
      const ruleCardContent = readBundledRuleCard(result.system);
      if (ruleCardContent) {
        const sysPaths = processingPaths(homeDir, result.system);
        await fileIO.mkdir(norm(sysPaths.base));
        await fileIO.writeFile(norm(sysPaths.ruleCard), ruleCardContent);
      }
    }
  }

  // 8b. Materialize inline world content from the chosen seed, if the campaign
  // was built from a rich .mvworld. This runs entirely in code — the entity
  // tree, maps, rules, and calendar never pass through the setup agent's
  // context. NPCs/locations/factions/lore/items become entity files (the DM
  // picks them up via the entity registry, which is scanned from disk at
  // session start); maps and calendar seed runtime state. The player-facing
  // compendium and the PC sheet are deliberately left unseeded — see
  // materializeWorldContent.
  if (result.worldSlug) {
    const userWorldsDir = homeDir ? machinePaths(homeDir).worldsDir : undefined;
    const world = loadWorldBySlug(result.worldSlug, userWorldsDir);
    if (world) {
      await materializeWorldContent(root, world, fileIO);
    }
  }

  // 9. Copy the confirmed character portrait (if any) from the __setup__
  // scratch campaign into the new campaign's characters/ dir. The setup
  // agent's set_portrait tool wrote it to
  // <campaignsDir>/__setup__/characters/<slug>-portrait.png. Missing file
  // is the no-portraits case — proceed silently.
  if (fileIO.readBinaryFile && fileIO.writeBinaryFile) {
    const setupPortraitPath = norm(`${campaignsDir}/__setup__/characters/${charSlug}-portrait.png`);
    const targetPortraitPath = norm(paths.characterPortrait(result.characterName));
    if (await fileIO.exists(setupPortraitPath)) {
      try {
        const bytes = await fileIO.readBinaryFile(setupPortraitPath);
        await fileIO.writeBinaryFile(targetPortraitPath, bytes);
      } catch {
        // Non-fatal: campaign succeeds without a portrait, DM context
        // injection skips this PC, life goes on.
      }
    }
  }

  return root;
}

/**
 * Write a seed's inline world content into a freshly scaffolded campaign.
 *
 * Pure serialization — no model in the loop. Maps the .mvworld inline content
 * (format-spec.md §10) onto the on-disk campaign format (format-spec.md §6, §4):
 *
 *  - entities.characters → characters/<slug>.md  (NPCs only; the PC is created
 *    during chargen, so any seed entity flagged `type: PC` is skipped to avoid
 *    duplicating / colliding with the live character)
 *  - entities.locations  → locations/<slug>/index.md
 *  - entities.factions   → factions/<slug>.md
 *  - entities.lore       → lore/<slug>.md
 *  - entities.items      → items/<slug>.md
 *  - rules               → rules/<slug>.md  (verbatim rule-card content)
 *  - maps                → state/maps.json   (authoritative runtime copy)
 *  - calendar            → state/clocks.json (world time + epoch, idle clocks)
 *
 * Deliberately NOT seeded:
 *  - campaign/compendium.json — the compendium is the *player-facing* knowledge
 *    base ("what the player has learned"). A fresh seed's player knows nothing,
 *    so it must start empty: pre-filling it both spoils the player's discovery
 *    and misinforms the DM about what the party already knows.
 *  - the PC character sheet — created live during chargen.
 *  - campaign/log.json entries — a seed carries no prior episodic record.
 *
 * Entity filenames come from the canonical `campaignPaths` helpers, which
 * slugify the entity title — so a correctly authored seed (record key ==
 * slugify(title)) round-trips, and a mismatched key still lands on the
 * engine-canonical path rather than a parallel orphan file.
 */
export async function materializeWorldContent(
  root: string,
  world: WorldFile,
  fileIO: FileIO,
): Promise<void> {
  const paths = campaignPaths(root);
  const ents = world.entities;

  if (ents) {
    for (const entity of Object.values(ents.characters ?? {})) {
      // The PC comes from chargen — never materialize one from the seed.
      if (String(entity.frontMatter?.type ?? "").toLowerCase() === "pc") continue;
      await fileIO.writeFile(
        norm(paths.character(entity.title)),
        serializeEntity(entity.title, entity.frontMatter, entity.body, []),
      );
    }

    for (const entity of Object.values(ents.locations ?? {})) {
      // Locations live in their own subdirectory (index.md) — mkdir first.
      const locPath = norm(paths.location(entity.title));
      await fileIO.mkdir(locPath.replace(/\/index\.md$/, ""));
      await fileIO.writeFile(
        locPath,
        serializeEntity(entity.title, entity.frontMatter, entity.body, []),
      );
    }

    for (const entity of Object.values(ents.factions ?? {})) {
      await fileIO.writeFile(
        norm(paths.faction(entity.title)),
        serializeEntity(entity.title, entity.frontMatter, entity.body, []),
      );
    }
    for (const entity of Object.values(ents.lore ?? {})) {
      await fileIO.writeFile(
        norm(paths.lore(entity.title)),
        serializeEntity(entity.title, entity.frontMatter, entity.body, []),
      );
    }
    for (const entity of Object.values(ents.items ?? {})) {
      await fileIO.writeFile(
        norm(paths.item(entity.title)),
        serializeEntity(entity.title, entity.frontMatter, entity.body, []),
      );
    }
  }

  // Rule cards → the campaign's rules/ dir, written verbatim.
  for (const [slug, content] of Object.entries(world.rules ?? {})) {
    if (typeof content === "string" && content.trim()) {
      await fileIO.writeFile(norm(paths.rule(slug)), content);
    }
  }

  // Maps → authoritative runtime store. The engine hydrates maps from
  // state/maps.json on load; per-location JSON copies aren't reconstructable
  // from the flat, location-agnostic world.maps map, so we seed only the store.
  if (world.maps && Object.keys(world.maps).length > 0) {
    await fileIO.writeFile(
      norm(`${root}/state/maps.json`),
      JSON.stringify(world.maps, null, 2) + "\n",
    );
  }

  // Calendar → state/clocks.json. The world carries calendar time + epoch but
  // no alarms; pair it with an idle combat clock.
  if (world.calendar) {
    const clocks: ClocksState = {
      calendar: {
        current: world.calendar.current,
        epoch: world.calendar.epoch,
        display_format: world.calendar.display_format,
        alarms: [],
      },
      combat: { current: 0, active: false, alarms: [] },
    };
    await fileIO.writeFile(
      norm(`${root}/state/clocks.json`),
      JSON.stringify(clocks, null, 2) + "\n",
    );
  }
}

/**
 * Update an existing returning player file with newly captured metadata.
 * Only sets age_group if missing, and appends content boundaries if none exist.
 */
async function updateReturningPlayer(
  playerPath: string,
  result: SetupResult,
  fileIO: FileIO,
): Promise<void> {
  const raw = await fileIO.readFile(playerPath);
  const { frontMatter, body, changelog } = parseFrontMatter(raw);
  const title = (frontMatter._title as string) || result.playerName;
  let changed = false;

  // Set age_group if missing and newly provided
  if (result.ageGroup && !frontMatter.age_group) {
    frontMatter.age_group = result.ageGroup;
    changed = true;
  }

  // Append initial content boundaries if none exist and we have new data
  let newBody = body;
  const hasSection = extractSection(body, "Content Boundaries") !== undefined;
  if (!hasSection && (result.contentPreferences || result.ageGroup)) {
    const section = buildInitialContentBoundaries(result.ageGroup, result.contentPreferences);
    if (section) {
      newBody = body ? `${body}\n\n${section}` : section;
      changed = true;
    }
  }

  if (changed) {
    await fileIO.writeFile(playerPath, serializeEntity(title, frontMatter, newBody, changelog));
  }
}

/**
 * Build the initial body for a new player entity based on age group and
 * any content preferences captured during setup.
 */
function buildInitialContentBoundaries(
  ageGroup?: string,
  contentPreferences?: string,
): string {
  const lines: string[] = [];

  if (ageGroup === "child") {
    lines.push("- No profanity", "- No sexual content", "- No graphic violence");
  } else if (ageGroup === "teenager") {
    lines.push("- Discretion cuts on sexual content");
  }

  if (contentPreferences) {
    for (const line of contentPreferences.split("\n").map(l => l.trim()).filter(Boolean)) {
      lines.push(line.startsWith("- ") ? line : `- ${line}`);
    }
  }

  if (lines.length === 0) return "";
  return `## Content Boundaries\n${lines.join("\n")}`;
}

/**
 * Re-exported from utils/slug for backwards compatibility.
 * The canonical entity-name → slug function lives in `../utils/slug.js` so
 * the filesystem path helpers can defensively slugify without creating a
 * circular dependency through this file.
 */
export { slugify };
