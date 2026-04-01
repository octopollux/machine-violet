import type { FileIO } from "./scene-manager.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignConfig } from "./setup-agent.js";
import { campaignDirs, campaignPaths, machineDirs, machinePaths } from "../tools/filesystem/index.js";
import { serializeEntity, parseFrontMatter, extractSection } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { findSystem, readBundledRuleCard } from "../config/systems.js";
import { processingPaths } from "../config/processing-paths.js";

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
      display_resources: ["HP"],
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

  // 7. Write starting location (minimal)
  const locationSlug = "starting-location";
  const locationPath = norm(paths.location(locationSlug));
  const locationDir = locationPath.replace(/\/index\.md$/, "");
  await fileIO.mkdir(locationDir);
  const locationContent = serializeEntity(
    "Starting Location",
    { type: "Location" },
    "The story begins here.",
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

  return root;
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
 * Convert a name to a filesystem-safe slug.
 * Strips leading articles (the, a, an) so "The Black Coin" and "Black Coin"
 * produce the same slug, preventing accidental duplicate entities.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
