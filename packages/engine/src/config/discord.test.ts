import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDiscordSettings, saveDiscordSettings } from "./discord.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mv-discord-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadDiscordSettings", () => {
  it("returns { enabled: null } when file is missing", () => {
    const result = loadDiscordSettings(tempDir);
    expect(result).toEqual({ enabled: null });
  });

  it("returns { enabled: null } when file is corrupt", () => {
    writeFileSync(join(tempDir, "discord-settings.json"), "not json", "utf-8");
    const result = loadDiscordSettings(tempDir);
    expect(result).toEqual({ enabled: null });
  });

  it("returns { enabled: null } when enabled field is not a boolean", () => {
    writeFileSync(join(tempDir, "discord-settings.json"), JSON.stringify({ enabled: "yes" }), "utf-8");
    const result = loadDiscordSettings(tempDir);
    expect(result).toEqual({ enabled: null });
  });
});

describe("saveDiscordSettings", () => {
  it("saves and loads true", () => {
    saveDiscordSettings(tempDir, { enabled: true });
    const result = loadDiscordSettings(tempDir);
    expect(result).toEqual({ enabled: true });
  });

  it("saves and loads false", () => {
    saveDiscordSettings(tempDir, { enabled: false });
    const result = loadDiscordSettings(tempDir);
    expect(result).toEqual({ enabled: false });
  });

  it("writes valid JSON to disk", () => {
    saveDiscordSettings(tempDir, { enabled: true });
    const raw = readFileSync(join(tempDir, "discord-settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ enabled: true });
  });
});
