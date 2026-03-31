/**
 * Lightweight client-side settings persistence.
 *
 * Reads/writes ~/.machine-violet/client-settings.json (or platform equivalent).
 * No server round-trip — these are per-machine preferences.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../utils/paths.js";

export interface ClientSettings {
  devModeEnabled: boolean;
  showVerbose: boolean;
}

const DEFAULTS: ClientSettings = {
  devModeEnabled: false,
  showVerbose: false,
};

const FILENAME = "client-settings.json";

function settingsPath(): string {
  return join(configDir(), FILENAME);
}

/** Load client settings from disk. Returns defaults for missing/corrupt file. */
export async function loadClientSettings(): Promise<ClientSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ClientSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist client settings to disk. Creates the config directory if needed. */
export async function saveClientSettings(settings: ClientSettings): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}
