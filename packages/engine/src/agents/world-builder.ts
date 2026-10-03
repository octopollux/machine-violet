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
import type { WorldFile, WorldEntity } from "@machine-violet/shared/types/world.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";
import { getCampaignKnowledge } from "../knowledge/store.js";
import type { KnowledgeOperation, KnowledgeValue } from "@machine-violet/shared/types/knowledge.js";

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

  // 3. Create the player-facing character identity
  const knowledge = await getCampaignKnowledge(root, fileIO, {create:true});
  let charBody = result.characterDescription || "A newly created character. Their story unfolds through play.";
  if (result.characterDetails) {
    charBody += "\n\n## Character Details\n" + result.characterDetails;
  }
  const charFields:Record<string,KnowledgeValue> = {
      type: "PC",
      player: result.playerName,
      display_resources: "HP",
      ...(result.themeColor ? {theme_color: result.themeColor} : {}),
  };
  const character = await knowledge.mutate([{op:"upsert",collection:"Characters",name:result.characterName,fields:charFields,body:charBody,visibility:"player-facing"}],{source:"setup"});

  // 4. Create the party record with an explicit character reference
  const charSlug = slugify(result.characterName);
  await knowledge.mutate([{op:"create_collection",name:"Party",note:"Player roster and shared resources"},{op:"upsert",collection:"Party",name:"The Party",fields:{members:[{$ref:character.identities[0].uid}]},visibility:"player-facing"}],{source:"setup"});

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
  await knowledge.mutate([{op:"upsert",collection:"Locations",name:"Starting Location",fields:{type:"Location",placeholder:true},body:"Placeholder: rename once the opening locale has a real name in the fiction."}],{source:"setup"});

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

  // 8b. Materialize unchanged .mvworld seed records into SQLite knowledge;
  // maps, rules and calendar keep their existing storage boundaries.
  if (result.worldSlug) {
    const userWorldsDir = homeDir ? machinePaths(homeDir).worldsDir : undefined;
    const world = loadWorldBySlug(result.worldSlug, userWorldsDir);
    if (world) {
      await materializeWorldContent(root, world, fileIO, result.forkSelections);
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
 * Materialize unchanged .mvworld content into a new campaign without a model call.
 * Entity front matter/body become typed fields and bulk text in knowledge.sqlite.
 * Authored aliases and exact known [[Name]] metadata references become identity
 * handles and graph edges. Unknown links and arbitrary prose remain literal text.
 * Rules, maps and calendar retain their existing file formats; PC seed records
 * and the player knowledge projection are deliberately not seeded.
 */
export async function materializeWorldContent(
  root: string,
  world: WorldFile,
  fileIO: FileIO,
  selections?: Record<string, string>,
): Promise<void> {
  const paths = campaignPaths(root);
  const ents = world.entities;

  // A scoped entity (appliesWhen) is materialized only if its fork resolved to
  // its option; universal entities (no appliesWhen) always are. This keeps a
  // branch-specific NPC/location out of campaigns that took a different fork.
  const applies = (e: WorldEntity): boolean =>
    !e.appliesWhen || selections?.[e.appliesWhen.fork] === e.appliesWhen.option;

  if (ents) {
    const knowledge = await getCampaignKnowledge(root, fileIO, { create: true });
    const operations: KnowledgeOperation[] = [];
    const selected: WorldEntity[] = [];
    const authoredHandles = new Set<string>();
    const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    for (const [category, collection] of Object.entries({ characters: "Characters", locations: "Locations", factions: "Factions", lore: "Lore", items: "Items" })) {
      for (const entity of Object.values(ents[category as keyof typeof ents] ?? {})) {
        if (!applies(entity) || String(entity.frontMatter?.type ?? "").toLowerCase() === "pc") continue;
        const aliases = typeof entity.frontMatter?.additional_names === "string"
          ? entity.frontMatter.additional_names.split(",").map(name => name.trim()).filter(Boolean) : [];
        selected.push(entity);
        for (const handle of [entity.title, ...aliases]) authoredHandles.add(normalize(handle));
        operations.push({ op: "upsert", collection, name: entity.title, aliases, fields: entity.frontMatter as Record<string, KnowledgeValue>, body: entity.body });
      }
    }
    // Relationships are appended after every identity has been allocated in the
    // same transaction. Only an entire metadata value authored as [[Name]] is a
    // relationship declaration; bodies and ambiguous prose do not create edges.
    for (const entity of selected) {
      for (const [key, value] of Object.entries(entity.frontMatter ?? {})) {
        if (typeof value !== "string") continue;
        const match = /^\[\[(.+)\]\]$/.exec(value.trim());
        if (!match) continue;
        const target = match[1].trim();
        if (authoredHandles.has(normalize(target)) || await knowledge.resolve(target)) {
          operations.push({ op: "add_reference", source: entity.title, target, label: `field:${key}` });
        }
      }
    }
    if (operations.length) await knowledge.mutate(operations, { source: "seed" });
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
