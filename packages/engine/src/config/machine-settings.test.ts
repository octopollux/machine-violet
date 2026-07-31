import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMachineSettings, saveMachineSettings } from "./machine-settings.js";

// Real fs against a temp dir (matching discord.test.ts / connections.test.ts)
// rather than a `node:fs` module mock: the dir-creation behavior these settings
// depend on (#768) is exactly what a mocked fs can't observe.
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mv-machine-settings-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadMachineSettings", () => {
  it("returns defaults when file is missing", () => {
    expect(loadMachineSettings(tempDir)).toEqual({ devModeEnabled: false });
  });

  it("returns defaults when file is corrupt", () => {
    writeFileSync(join(tempDir, "machine-settings.json"), "not json", "utf-8");
    expect(loadMachineSettings(tempDir)).toEqual({ devModeEnabled: false });
  });

  it("loads saved settings", () => {
    writeFileSync(join(tempDir, "machine-settings.json"), JSON.stringify({ devModeEnabled: true }), "utf-8");
    expect(loadMachineSettings(tempDir)).toEqual({ devModeEnabled: true });
  });

  it("rejects non-boolean devModeEnabled", () => {
    writeFileSync(join(tempDir, "machine-settings.json"), JSON.stringify({ devModeEnabled: "yes" }), "utf-8");
    expect(loadMachineSettings(tempDir)).toEqual({ devModeEnabled: false });
  });
});

describe("saveMachineSettings", () => {
  it("writes JSON to the correct path", () => {
    saveMachineSettings(tempDir, { devModeEnabled: true });
    const raw = readFileSync(join(tempDir, "machine-settings.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ devModeEnabled: true });
  });

  it("round-trips through loadMachineSettings", () => {
    saveMachineSettings(tempDir, { devModeEnabled: true });
    expect(loadMachineSettings(tempDir)).toEqual({ devModeEnabled: true });
  });

  it("creates the config dir when it does not exist yet (#768)", () => {
    const freshDir = join(tempDir, "MachineViolet");
    saveMachineSettings(freshDir, { devModeEnabled: true });
    expect(loadMachineSettings(freshDir)).toEqual({ devModeEnabled: true });
  });
});
