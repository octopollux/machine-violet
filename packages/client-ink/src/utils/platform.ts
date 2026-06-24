import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Get the platform-conventional directory for user config files
 * (.env, api-keys.json, config.json). Separate from the install tree
 * so that installer updates (e.g. Squirrel.Windows) don't destroy config.
 *
 * - Windows: %APPDATA%\MachineViolet
 * - macOS:   ~/Library/Application Support/MachineViolet
 * - Linux:   $XDG_CONFIG_HOME/machine-violet or ~/.config/machine-violet
 */
export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
): string {
  const home = homedir();

  if (platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) return join(appData, "MachineViolet");
    return join(home, "AppData", "Roaming", "MachineViolet");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "MachineViolet");
  }

  // Linux / others: respect XDG_CONFIG_HOME
  const xdgConfig = process.env["XDG_CONFIG_HOME"];
  if (xdgConfig) return join(xdgConfig, "machine-violet");
  return join(home, ".config", "machine-violet");
}
