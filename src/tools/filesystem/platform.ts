import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Get the default campaign storage directory, platform-aware.
 * Prefers cloud-synced locations per design spec:
 * - Windows: ~/Documents
 * - macOS: ~/Documents
 * - Linux: XDG_DATA_HOME or ~/.local/share
 */
export function defaultCampaignRoot(
  platform: NodeJS.Platform = process.platform,
): string {
  const home = homedir();

  if (platform === "win32" || platform === "darwin") {
    return join(home, "Documents", ".machine-violet");
  }

  // Linux / others: respect XDG
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg) return join(xdg, ".machine-violet");
  return join(home, ".local", "share", ".machine-violet");
}
