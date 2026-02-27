import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { CampaignInfo } from "../shared/protocol.js";

/**
 * Scan a campaigns directory for subdirectories containing config.json.
 * Each valid subdirectory is a campaign.
 */
export async function scanCampaigns(campaignsDir: string): Promise<CampaignInfo[]> {
  const campaigns: CampaignInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(campaignsDir);
  } catch {
    return campaigns;
  }

  for (const entry of entries) {
    const dirPath = join(campaignsDir, entry);
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) continue;

      const configPath = join(dirPath, "config.json");
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw);
      campaigns.push({
        slug: basename(dirPath),
        name: config.name ?? basename(dirPath),
        path: dirPath,
      });
    } catch {
      // Not a campaign directory or bad config — skip
    }
  }

  return campaigns;
}
