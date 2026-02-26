import { join } from "node:path";

/**
 * Main menu options and campaign listing.
 */
export type MenuChoice = "new_campaign" | "continue_campaign" | "just_jump_in";

export interface CampaignEntry {
  name: string;
  path: string;
  lastPlayed?: string;
}

/**
 * List existing campaigns in the campaigns directory.
 * Each subdirectory with a config.json is a campaign.
 */
export async function listCampaigns(
  campaignsDir: string,
  listDir: (path: string) => Promise<string[]>,
  exists: (path: string) => Promise<boolean>,
): Promise<CampaignEntry[]> {
  const entries: CampaignEntry[] = [];

  let dirs: string[];
  try {
    dirs = await listDir(campaignsDir);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const campaignPath = join(campaignsDir, dir);
    const configPath = join(campaignPath, "config.json");
    if (await exists(configPath)) {
      entries.push({ name: dir, path: campaignPath });
    }
  }

  return entries;
}
