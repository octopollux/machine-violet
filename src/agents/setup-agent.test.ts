import { describe, it, expect, vi } from "vitest";
import { buildCampaignConfig, generateThemeColor } from "./setup-agent.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignWorld, slugify } from "./world-builder.js";
import type { FileIO } from "./scene-manager.js";

/** Helper to build a minimal SetupResult for testing */
function makeSetupResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    genre: "Classic fantasy",
    system: null,
    campaignName: "The Shattered Crown",
    campaignPremise: "A kingdom's heir is dead.",
    mood: "Balanced",
    difficulty: "Balanced",
    personality: { name: "The Chronicler", prompt_fragment: "You are The Chronicler." },
    playerName: "Player",
    characterName: "Kael",
    characterDescription: "A wandering sellsword",
    themeColor: "#8888aa",
    ...overrides,
  };
}

describe("buildCampaignConfig", () => {
  it("builds valid config from setup result", () => {
    const result = makeSetupResult();
    const config = buildCampaignConfig(result);

    expect(config.name).toBe(result.campaignName);
    expect(config.dm_personality).toBe(result.personality);
    expect(config.players).toHaveLength(1);
    expect(config.players[0].name).toBe(result.playerName);
    expect(config.players[0].character).toBe(result.characterName);
    expect(config.context.retention_exchanges).toBe(5);
    expect(config.recovery.enable_git).toBe(true);
  });

  it("includes version and createdAt", () => {
    const result = makeSetupResult();
    const config = buildCampaignConfig(result);

    expect(config.version).toBe(1);
    expect(config.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("generateThemeColor", () => {
  it("returns a hex color string", () => {
    const color = generateThemeColor("Kael");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns different colors for different names", () => {
    const c1 = generateThemeColor("Kael");
    const c2 = generateThemeColor("Sister Venn");
    expect(c1).not.toBe(c2);
  });
});

describe("slugify", () => {
  it("converts names to filesystem slugs", () => {
    expect(slugify("The Shattered Crown")).toBe("shattered-crown");
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("  spaces  ")).toBe("spaces");
    expect(slugify("A Very Long Name That Exceeds Fifty Characters In Total Length Here")).toHaveLength(50);
    // Articles stripped — prevents duplicate entities
    expect(slugify("The Black Coin")).toBe("black-coin");
    expect(slugify("Black Coin")).toBe("black-coin");
    expect(slugify("A Hooded Figure")).toBe("hooded-figure");
    expect(slugify("An Old Tower")).toBe("old-tower");
  });
});

describe("buildCampaignWorld", () => {
  it("creates campaign directory structure and files", async () => {
    const files: Record<string, string> = {};
    const dirs = new Set<string>();
    const { norm } = await import("../utils/paths.js");

    const fileIO: FileIO = {
      readFile: vi.fn(async (path) => files[norm(path)] ?? ""),
      writeFile: vi.fn(async (path, content) => { files[norm(path)] = content; }),
      appendFile: vi.fn(async (path, content) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
      mkdir: vi.fn(async (path) => { dirs.add(norm(path)); }),
      exists: vi.fn(async (path) => norm(path) in files || dirs.has(norm(path))),
      listDir: vi.fn(async () => []),
    };

    const result = makeSetupResult();
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

    // Campaign log was written (JSON format)
    const logFile = Object.keys(files).find((p) => p.endsWith("log.json"));
    expect(logFile).toBeTruthy();
    const logData = JSON.parse(files[logFile!]);
    expect(logData.campaignName).toBe(result.campaignName);
    expect(logData.entries).toEqual([]);

    // Location was created
    const locationFile = Object.keys(files).find((p) => p.includes("/locations/"));
    expect(locationFile).toBeTruthy();

    // Party file was written with PC as member
    const partyFile = Object.keys(files).find((p) => p.endsWith("/party.md"));
    expect(partyFile).toBeTruthy();
    expect(files[partyFile!]).toContain("The Party");
    expect(files[partyFile!]).toContain("[[");

    // Player file was written
    const playerFile = Object.keys(files).find((p) => p.includes("/players/"));
    expect(playerFile).toBeTruthy();

    // Standard directories were created
    expect(dirs.size).toBeGreaterThanOrEqual(8);
  });
});
