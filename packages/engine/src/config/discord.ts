import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const STORE_FILENAME = "discord-settings.json";

export interface DiscordSettings {
  enabled: boolean;
}

// Default to on — Rich Presence is normal for games. Users can opt out
// from the Settings → Discord screen.
const DEFAULT_SETTINGS: DiscordSettings = { enabled: true };

/** Load Discord settings from the config directory. Returns the default (enabled) if missing or corrupt. */
export function loadDiscordSettings(appDir: string): DiscordSettings {
  try {
    const raw = readFileSync(join(appDir, STORE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DiscordSettings>;
    if (typeof parsed.enabled === "boolean") return { enabled: parsed.enabled };
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist Discord settings to the config directory. Creates it if needed. */
export function saveDiscordSettings(appDir: string, settings: DiscordSettings): void {
  // The config dir may not exist yet — any of its writers can be the first
  // one on a fresh install (#768).
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(appDir, STORE_FILENAME), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
