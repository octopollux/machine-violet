import type { FileIO } from "./scene-manager.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignConfig } from "./setup-agent.js";
import { campaignDirs, campaignPaths } from "../tools/filesystem/index.js";
import { serializeEntity } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";

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
  const charContent = serializeEntity(
    result.characterName,
    {
      type: "PC",
      player: result.playerName,
      display_resources: ["HP"],
      theme_color: result.themeColor,
    },
    result.characterDescription || "A newly created character. Their story unfolds through play.",
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

  // 5. Write player file
  const playerPath = norm(paths.player(slugify(result.playerName)));
  const playerContent = serializeEntity(
    result.playerName,
    { type: "Player" },
    "",
    [],
  );
  await fileIO.writeFile(playerPath, playerContent);

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

  return root;
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
