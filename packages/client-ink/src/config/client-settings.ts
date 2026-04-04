/**
 * Lightweight client-side settings persistence.
 *
 * Reads/writes client-settings.json under the client config directory
 * returned by configDir() (platform config dir in production, or
 * process.cwd() in dev/non-compiled mode).
 * No server round-trip — these are per-machine preferences.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../utils/paths.js";

export interface ClientSettings {
  showVerbose: boolean;
}

const DEFAULTS: ClientSettings = {
  showVerbose: false,
};

const FILENAME = "client-settings.json";

function settingsPath(): string {
  return join(configDir(), FILENAME);
}

/** Coerce parsed JSON to valid ClientSettings, falling back to defaults. */
function sanitize(input: unknown): ClientSettings {
  const result: ClientSettings = { ...DEFAULTS };
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.showVerbose === "boolean") result.showVerbose = obj.showVerbose;
  }
  return result;
}

/** Load client settings from disk. Returns defaults for missing/corrupt file. */
export async function loadClientSettings(): Promise<ClientSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf-8");
    return sanitize(JSON.parse(raw));
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
