import { describe, it, expect, vi } from "vitest";
import { validateCampaign } from "./validator.js";
import type { ValidationIO } from "./validator.js";
import type { MapData } from "../../types/maps.js";
import type { ClocksState } from "../../types/clocks.js";

// --- Mock ValidationIO ---

function mockIO(files: Record<string, string>, dirs: Record<string, string[]>): ValidationIO {
  return {
    readFile: vi.fn(async (path) => files[path] ?? ""),
    listDir: vi.fn(async (path) => dirs[path] ?? []),
    exists: vi.fn(async (path) => path in files || path in dirs),
  };
}

function cleanClocks(): ClocksState {
  return {
    calendar: { epoch: "0", current: 100, display_format: "d/m/y", alarms: [] },
    combat: { active: false, current: 0, alarms: [] },
  };
}

// --- Tests ---

describe("validateCampaign", () => {
  it("validates a clean campaign with no issues", async () => {
    const io = mockIO(
      {
        "/camp/config.json": '{"name": "Test Campaign"}',
        "/camp/characters/aldric.md": "# Aldric\n\n**Type:** PC\n\nA warrior.",
      },
      {
        "/camp/characters": ["aldric.md"],
      },
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.filesChecked).toBeGreaterThanOrEqual(2);
  });

  it("reports missing config.json", async () => {
    const io = mockIO({}, {});

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    expect(result.errorCount).toBe(1);
    expect(result.issues[0].message).toContain("Missing config.json");
  });

  it("reports invalid JSON in config", async () => {
    const io = mockIO(
      { "/camp/config.json": "{ invalid json" },
      {},
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    expect(result.errorCount).toBe(1);
    expect(result.issues[0].message).toContain("Invalid JSON");
  });

  it("reports entity files missing title", async () => {
    const io = mockIO(
      {
        "/camp/config.json": "{}",
        "/camp/characters/broken.md": "No title here\n\n**Type:** NPC",
      },
      {
        "/camp/characters": ["broken.md"],
      },
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    expect(result.issues.some((i) => i.message.includes("Missing H1 title"))).toBe(true);
  });

  it("reports empty entity files", async () => {
    const io = mockIO(
      {
        "/camp/config.json": "{}",
        "/camp/characters/empty.md": "",
      },
      {
        "/camp/characters": ["empty.md"],
      },
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    expect(result.issues.some((i) => i.message.includes("Empty file"))).toBe(true);
  });

  it("validates map entity bounds", async () => {
    const map: MapData = {
      id: "test",
      gridType: "square",
      bounds: { width: 10, height: 10 },
      defaultTerrain: "floor",
      regions: [],
      terrain: {},
      entities: {
        "15,15": [{ id: "oob", type: "npc" }], // out of bounds
      },
      annotations: {},
      links: [],
      meta: {},
    };

    const io = mockIO(
      { "/camp/config.json": "{}" },
      {},
    );

    const result = await validateCampaign("/camp", { test: map }, cleanClocks(), io);

    expect(result.issues.some((i) => i.message.includes("out of bounds"))).toBe(true);
  });

  it("validates clock alarm integrity", async () => {
    const clocks: ClocksState = {
      calendar: {
        epoch: "0",
        current: 100,
        display_format: "d/m/y",
        alarms: [
          { id: "a1", fires_at: 50, message: "Past alarm" }, // fires_at < current
        ],
      },
      combat: { active: false, current: 0, alarms: [] },
    };

    const io = mockIO(
      { "/camp/config.json": "{}" },
      {},
    );

    const result = await validateCampaign("/camp", {}, clocks, io);

    expect(result.issues.some((i) => i.message.includes("Past alarm"))).toBe(true);
  });

  it("validates location entity files in subdirectories", async () => {
    const io = mockIO(
      {
        "/camp/config.json": "{}",
        "/camp/locations/tavern/index.md": "# The Rusty Nail\n\n**Type:** Location\n\nA seedy tavern.",
      },
      {
        "/camp/locations": ["tavern"],  // subdirectory, not .md file
        "/camp/locations/tavern": ["index.md"],
      },
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    // Should find and validate the location file (config + location = 2 files checked)
    expect(result.filesChecked).toBe(2);
    expect(result.issues.filter((i) => i.file.includes("tavern")).length).toBe(0);
  });

  it("counts errors and warnings separately", async () => {
    const io = mockIO(
      {
        "/camp/config.json": "{ bad json",
        "/camp/characters/nohead.md": "Just content, no title\n\n**Type:** NPC",
      },
      {
        "/camp/characters": ["nohead.md"],
      },
    );

    const result = await validateCampaign("/camp", {}, cleanClocks(), io);

    // Invalid JSON is an error, missing title is an error, missing Type could be either
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.errorCount + result.warningCount).toBe(result.issues.length);
  });
});
