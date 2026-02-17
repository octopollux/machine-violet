import type { FileIO } from "./scene-manager.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignConfig } from "./setup-agent.js";
import { campaignDirs, campaignPaths } from "../tools/filesystem/index.js";
import { serializeEntity } from "../tools/filesystem/index.js";

/**
 * Build the entire campaign directory from setup results.
 * This is Step 3 from game-initialization.md — mostly T1 file creation.
 */
export async function buildCampaignWorld(
  campaignsDir: string,
  result: SetupResult,
  fileIO: FileIO,
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
    await fileIO.mkdir(dir.replace(/\\/g, "/"));
  }

  // 2. Write config.json
  const config = buildCampaignConfig(result);
  const paths = campaignPaths(root);
  await fileIO.writeFile(
    paths.config.replace(/\\/g, "/"),
    JSON.stringify(config, null, 2) + "\n",
  );

  // 3. Write character file
  const charPath = paths.character(slugify(result.characterName)).replace(/\\/g, "/");
  const charContent = serializeEntity(
    result.characterName,
    {
      type: "PC",
      player: result.playerName,
      display_resources: ["HP"],
      theme_color: result.themeColor,
    },
    result.characterDescription || "A character awaiting their story.",
    [],
  );
  await fileIO.writeFile(charPath, charContent);

  // 4. Write player file
  const playerPath = paths.player(slugify(result.playerName)).replace(/\\/g, "/");
  const playerContent = serializeEntity(
    result.playerName,
    { type: "Player" },
    "",
    [],
  );
  await fileIO.writeFile(playerPath, playerContent);

  // 5. Write campaign log (first entry)
  const logPath = paths.log.replace(/\\/g, "/");
  const logContent = `# Campaign Log: ${result.campaignName}\n\n${result.campaignPremise}\n`;
  await fileIO.writeFile(logPath, logContent);

  // 6. Write starting location (minimal)
  const locationSlug = "starting-location";
  const locationPath = paths.location(locationSlug).replace(/\\/g, "/");
  const locationDir = locationPath.replace(/\/index\.md$/, "");
  await fileIO.mkdir(locationDir);
  const locationContent = serializeEntity(
    "Starting Location",
    { type: "Location" },
    "The story begins here.",
    [],
  );
  await fileIO.writeFile(locationPath, locationContent);

  return root;
}

/**
 * Convert a name to a filesystem-safe slug.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
