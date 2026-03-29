import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_FILENAME = "discord-settings.json";

export interface DiscordSettings {
  /** `true` = opted in, `false` = opted out, `null` = not yet asked. */
  enabled: boolean | null;
}

/** Load Discord settings from the config directory. Returns `{ enabled: null }` if missing or corrupt. */
export function loadDiscordSettings(appDir: string): DiscordSettings {
  try {
    const raw = readFileSync(join(appDir, STORE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DiscordSettings>;
    if (typeof parsed.enabled === "boolean") return { enabled: parsed.enabled };
    return { enabled: null };
  } catch {
    return { enabled: null };
  }
}

/** Persist Discord settings to the config directory. */
export function saveDiscordSettings(appDir: string, settings: DiscordSettings): void {
  writeFileSync(join(appDir, STORE_FILENAME), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
