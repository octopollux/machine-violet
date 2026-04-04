import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_FILENAME = "machine-settings.json";

export interface MachineSettings {
  /** Whether advanced/dev features (content ingest, dev mode, etc.) are enabled. */
  devModeEnabled: boolean;
}

const DEFAULTS: MachineSettings = {
  devModeEnabled: false,
};

/** Load machine settings from the config directory. Returns defaults if missing or corrupt. */
export function loadMachineSettings(appDir: string): MachineSettings {
  try {
    const raw = readFileSync(join(appDir, STORE_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as Partial<MachineSettings>;
    return {
      devModeEnabled: typeof parsed.devModeEnabled === "boolean" ? parsed.devModeEnabled : DEFAULTS.devModeEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist machine settings to the config directory. */
export function saveMachineSettings(appDir: string, settings: MachineSettings): void {
  writeFileSync(join(appDir, STORE_FILENAME), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
