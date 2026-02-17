import { describe, it, expect, vi } from "vitest";
import { fastPathSetup, fullSetup, buildCampaignConfig } from "./setup-agent.js";
import type { SetupStep, SetupCallback } from "./setup-agent.js";
import { buildCampaignWorld, slugify } from "./world-builder.js";
import type { FileIO } from "./scene-manager.js";

/** Always picks the default (first) option */
const defaultChoice: SetupCallback = async (step: SetupStep) => step.defaultIndex;

/** Always picks index 1 */
const secondChoice: SetupCallback = async () => 1;

describe("fastPathSetup", () => {
  it("completes with all defaults", async () => {
    const result = await fastPathSetup(defaultChoice);

    expect(result.genre).toBeTruthy();
    expect(result.system).toBeNull(); // default is "no system"
    expect(result.campaignName).toBeTruthy();
    expect(result.personality.name).toBeTruthy();
    expect(result.personality.prompt_fragment).toBeTruthy();
    expect(result.characterName).toBeTruthy();
  });

  it("accepts freeform text input", async () => {
    const freeform: SetupCallback = async (step) => {
      if (step.prompt.includes("world")) return "Steampunk Victorian";
      if (step.prompt.includes("system")) return "Custom homebrew";
      if (step.prompt.includes("Dungeon Master")) return "A sardonic narrator who makes dry observations";
      if (step.prompt.includes("Who are you")) return "Lord Ashworth, disgraced inventor";
      return step.defaultIndex;
    };

    const result = await fastPathSetup(freeform);
    expect(result.genre).toBe("Steampunk Victorian");
    expect(result.characterName).toBe("Lord Ashworth, disgraced inventor");
    expect(result.personality.name).toBe("Custom");
  });
});

describe("fullSetup", () => {
  it("completes full flow with defaults", async () => {
    const result = await fullSetup(defaultChoice);

    expect(result.genre).toBeTruthy();
    expect(result.mood).toBeTruthy();
    expect(result.difficulty).toBeTruthy();
    expect(result.personality.name).toBeTruthy();
    expect(result.characterName).toBeTruthy();
    expect(result.playerName).toBe("Player"); // default is "Skip"
  });

  it("completes full flow with second choices", async () => {
    const result = await fullSetup(secondChoice);

    expect(result.genre).toBeTruthy();
    expect(result.system).toBeTruthy(); // second choice is FATE
  });
});

describe("buildCampaignConfig", () => {
  it("builds valid config from setup result", async () => {
    const result = await fastPathSetup(defaultChoice);
    const config = buildCampaignConfig(result);

    expect(config.name).toBe(result.campaignName);
    expect(config.dm_personality).toBe(result.personality);
    expect(config.players).toHaveLength(1);
    expect(config.players[0].name).toBe(result.playerName);
    expect(config.players[0].character).toBe(result.characterName);
    expect(config.context.retention_exchanges).toBe(5);
    expect(config.recovery.enable_git).toBe(true);
  });
});

describe("slugify", () => {
  it("converts names to filesystem slugs", () => {
    expect(slugify("The Shattered Crown")).toBe("the-shattered-crown");
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  spaces  ")).toBe("spaces");
    expect(slugify("A Very Long Name That Exceeds Fifty Characters In Total Length Here")).toHaveLength(50);
  });
});

describe("buildCampaignWorld", () => {
  it("creates campaign directory structure and files", async () => {
    const files: Record<string, string> = {};
    const dirs: Set<string> = new Set();
    const norm = (p: string) => p.replace(/\\/g, "/");

    const fileIO: FileIO = {
      readFile: vi.fn(async (path) => files[norm(path)] ?? ""),
      writeFile: vi.fn(async (path, content) => { files[norm(path)] = content; }),
      appendFile: vi.fn(async (path, content) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
      mkdir: vi.fn(async (path) => { dirs.add(norm(path)); }),
      exists: vi.fn(async (path) => norm(path) in files || dirs.has(norm(path))),
      listDir: vi.fn(async () => []),
    };

    const result = await fastPathSetup(defaultChoice);
    const root = await buildCampaignWorld("/tmp/campaigns", result, fileIO);

    // Directory was created
    expect(root).toContain("/tmp/campaigns/");

    // Config was written
    const configPath = Object.keys(files).find((p) => p.endsWith("config.json"));
    expect(configPath).toBeTruthy();
    const config = JSON.parse(files[configPath!]);
    expect(config.name).toBe(result.campaignName);

    // Character file was written
    const charFile = Object.keys(files).find((p) => p.includes("/characters/"));
    expect(charFile).toBeTruthy();
    expect(files[charFile!]).toContain(result.characterName);

    // Campaign log was written
    const logFile = Object.keys(files).find((p) => p.endsWith("log.md"));
    expect(logFile).toBeTruthy();
    expect(files[logFile!]).toContain(result.campaignName);

    // Location was created
    const locationFile = Object.keys(files).find((p) => p.includes("/locations/"));
    expect(locationFile).toBeTruthy();

    // Player file was written
    const playerFile = Object.keys(files).find((p) => p.includes("/players/"));
    expect(playerFile).toBeTruthy();

    // Standard directories were created
    expect(dirs.size).toBeGreaterThanOrEqual(8);
  });
});
