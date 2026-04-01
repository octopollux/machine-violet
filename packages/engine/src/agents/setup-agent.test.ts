import { describe, it, expect, vi } from "vitest";
import { buildCampaignConfig, generateThemeColor } from "./setup-agent.js";
import type { SetupResult } from "./setup-agent.js";
import { buildCampaignWorld, slugify } from "./world-builder.js";
import type { FileIO } from "./scene-manager.js";
import { resolveSystemSlug } from "./subagents/setup-conversation.js";

/** Helper to build a minimal SetupResult for testing */
function makeSetupResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    genre: "Classic fantasy",
    system: null,
    campaignName: "The Shattered Crown",
    campaignPremise: "A kingdom's heir is dead.",
    campaignDetail: null,
    mood: "Balanced",
    difficulty: "Balanced",
    personality: { name: "The Chronicler", prompt_fragment: "You are The Chronicler." },
    playerName: "Player",
    characterName: "Kael",
    characterDescription: "A wandering sellsword",
    characterDetails: null,
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
    expect(config.context.retention_exchanges).toBe(100);
    expect(config.recovery.enable_git).toBe(true);
  });

  it("passes campaign_detail through to config", () => {
    const result = makeSetupResult({ campaignDetail: "Roll for variant: THE PRETENDER" });
    const config = buildCampaignConfig(result);
    expect(config.campaign_detail).toBe("Roll for variant: THE PRETENDER");
  });

  it("omits campaign_detail when null", () => {
    const result = makeSetupResult({ campaignDetail: null });
    const config = buildCampaignConfig(result);
    expect(config.campaign_detail).toBeUndefined();
  });

  it("passes personality detail through to config", () => {
    const result = makeSetupResult({
      personality: { name: "Test", prompt_fragment: "Terse.", detail: "Use callbacks." },
    });
    const config = buildCampaignConfig(result);
    expect(config.dm_personality.detail).toBe("Use callbacks.");
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

describe("resolveSystemSlug", () => {
  it("returns known slugs unchanged", () => {
    expect(resolveSystemSlug("dnd-5e")).toBe("dnd-5e");
    expect(resolveSystemSlug("fate-accelerated")).toBe("fate-accelerated");
    expect(resolveSystemSlug("24xx")).toBe("24xx");
  });

  it("maps display names to slugs (case-insensitive)", () => {
    expect(resolveSystemSlug("D&D 5th Edition")).toBe("dnd-5e");
    expect(resolveSystemSlug("d&d 5th edition")).toBe("dnd-5e");
    expect(resolveSystemSlug("FATE Accelerated")).toBe("fate-accelerated");
    expect(resolveSystemSlug("Cairn")).toBe("cairn");
    expect(resolveSystemSlug("Charge RPG")).toBe("charge");
  });

  it("maps slugified display names to known slugs", () => {
    // "D&D 5e" → slugify → "d-d-5e" — doesn't match "dnd-5e"
    // but "D&D 5th Edition" → slugify → "d-d-5th-edition" — also doesn't match
    // These fall through to the slugified passthrough
    expect(resolveSystemSlug("Ironsworn")).toBe("ironsworn");
    expect(resolveSystemSlug("Breathless")).toBe("breathless");
  });

  it("returns slugified form for unknown systems", () => {
    expect(resolveSystemSlug("Mothership")).toBe("mothership");
    expect(resolveSystemSlug("Call of Cthulhu")).toBe("call-of-cthulhu");
    expect(resolveSystemSlug("My Custom System!")).toBe("my-custom-system");
  });
});

describe("buildCampaignWorld", () => {
  it("includes characterDetails in character file when present", async () => {
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

    const result = makeSetupResult({ characterDetails: "Fighter, level 1, standard array" });
    await buildCampaignWorld("/tmp/campaigns", result, fileIO);

    const charFile = Object.keys(files).find((p) => p.includes("/characters/"));
    expect(charFile).toBeTruthy();
    expect(files[charFile!]).toContain("Character Details");
    expect(files[charFile!]).toContain("Fighter, level 1, standard array");
  });

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
    const root = await buildCampaignWorld("/tmp/campaigns", result, fileIO, "/tmp/home");

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

    // Player file was written to machine-scope
    const playerFile = Object.keys(files).find((p) => p.includes("/tmp/home/players/"));
    expect(playerFile).toBeTruthy();

    // Standard directories were created
    expect(dirs.size).toBeGreaterThanOrEqual(8);
  });
});
