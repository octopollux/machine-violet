import { describe, it, expect } from "vitest";
import type { MapData } from "@machine-violet/shared/types/maps.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";
import {
  validateWikilinks,
  validateEntityFile,
  validateJson,
  validateMap,
  validateClocks,
  resolveRelativePath,
} from "./validation.js";

// --- resolveRelativePath ---

describe("resolveRelativePath", () => {
  it("resolves sibling file", () => {
    expect(resolveRelativePath("characters/aldric.md", "sable.md")).toBe(
      "characters/sable.md",
    );
  });

  it("resolves parent directory", () => {
    expect(
      resolveRelativePath(
        "characters/aldric.md",
        "../locations/town/index.md",
      ),
    ).toBe("locations/town/index.md");
  });

  it("resolves multiple parent navigation", () => {
    expect(
      resolveRelativePath(
        "campaign/scenes/001-tavern/transcript.md",
        "../../../characters/aldric.md",
      ),
    ).toBe("characters/aldric.md");
  });

  it("handles backslashes on Windows", () => {
    expect(
      resolveRelativePath(
        "characters\\aldric.md",
        "..\\locations\\town\\index.md",
      ),
    ).toBe("locations/town/index.md");
  });
});

// --- validateWikilinks ---

describe("validateWikilinks", () => {
  const existingPaths = new Set([
    "characters/aldric.md",
    "locations/town/index.md",
  ]);

  it("passes when all links resolve", () => {
    const files = [
      {
        path: "characters/aldric.md",
        content: "Met at [Town](../locations/town/index.md).",
      },
    ];
    const errors = validateWikilinks(files, existingPaths);
    expect(errors).toHaveLength(0);
  });

  it("flags dead links as warnings", () => {
    const files = [
      {
        path: "characters/aldric.md",
        content: "Saw [Dragon](../lore/dragon.md) fly overhead.",
      },
    ];
    const errors = validateWikilinks(files, existingPaths);
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
    expect(errors[0].message).toContain("Dead link");
    expect(errors[0].message).toContain("dragon.md");
  });

  it("checks multiple files", () => {
    const files = [
      {
        path: "characters/aldric.md",
        content: "Link to [missing](../lore/missing.md).",
      },
      {
        path: "characters/sable.md",
        content: "Link to [also missing](../factions/gone.md).",
      },
    ];
    const errors = validateWikilinks(files, existingPaths);
    expect(errors).toHaveLength(2);
  });

  it("handles files with no links", () => {
    const files = [{ path: "notes.md", content: "No links here." }];
    expect(validateWikilinks(files, existingPaths)).toHaveLength(0);
  });
});

// --- validateEntityFile ---

describe("validateEntityFile", () => {
  it("passes a valid entity file", () => {
    const content = `# Aldric

**Type:** PC

A brave paladin.

## Changelog
- **Scene 001**: Created.
`;
    expect(validateEntityFile("characters/aldric.md", content)).toHaveLength(0);
  });

  it("errors on empty file", () => {
    const errors = validateEntityFile("characters/empty.md", "");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("Empty file");
  });

  it("errors on missing title", () => {
    const content = `**Type:** NPC

Some text.
`;
    const errors = validateEntityFile("characters/bad.md", content);
    expect(errors.some((e) => e.message.includes("title"))).toBe(true);
  });

  it("warns on missing type", () => {
    const content = `# Unnamed

Just a description.
`;
    const errors = validateEntityFile("characters/unnamed.md", content);
    expect(errors.some((e) => e.message.includes("Type"))).toBe(true);
    expect(errors[0].severity).toBe("warning");
  });
});

// --- validateJson ---

describe("validateJson", () => {
  it("passes valid JSON", () => {
    expect(validateJson("config.json", '{"name":"test"}')).toHaveLength(0);
  });

  it("passes valid JSON array", () => {
    expect(validateJson("data.json", "[1, 2, 3]")).toHaveLength(0);
  });

  it("errors on invalid JSON", () => {
    const errors = validateJson("bad.json", "{broken");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("Invalid JSON");
  });

  it("errors on empty string", () => {
    const errors = validateJson("empty.json", "");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });
});

// --- validateMap ---

describe("validateMap", () => {
  function makeMap(overrides?: Partial<MapData>): MapData {
    return {
      id: "test",
      gridType: "square",
      bounds: { width: 10, height: 10 },
      defaultTerrain: "grass",
      regions: [],
      terrain: {},
      entities: {},
      annotations: {},
      links: [],
      meta: {},
      ...overrides,
    };
  }

  it("passes a valid map", () => {
    const map = makeMap({
      entities: { "5,5": [{ id: "G1", type: "Goblin" }] },
    });
    expect(validateMap("map.json", map, new Set())).toHaveLength(0);
  });

  it("errors on out-of-bounds entities", () => {
    const map = makeMap({
      entities: { "15,15": [{ id: "G1", type: "Goblin" }] },
    });
    const errors = validateMap("map.json", map, new Set());
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("out of bounds");
  });

  it("warns on PC without character file", () => {
    const map = makeMap({
      entities: { "5,5": [{ id: "PC:Aldric", type: "player" }] },
    });
    const errors = validateMap("map.json", map, new Set());
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
    expect(errors[0].message).toContain("no character file");
  });

  it("passes when PC has matching character file", () => {
    const map = makeMap({
      entities: { "5,5": [{ id: "PC:Aldric", type: "player" }] },
    });
    const errors = validateMap("map.json", map, new Set(["aldric"]));
    expect(errors).toHaveLength(0);
  });

  it("ignores non-PC entities for file check", () => {
    const map = makeMap({
      entities: { "5,5": [{ id: "G1", type: "Goblin" }] },
    });
    expect(validateMap("map.json", map, new Set())).toHaveLength(0);
  });
});

// --- validateClocks ---

describe("validateClocks", () => {
  function makeClocks(overrides?: Partial<ClocksState>): ClocksState {
    return {
      calendar: {
        current: 100,
        alarms: [],
        epoch: "campaign start",
        display_format: "day+time",
      },
      combat: {
        current: 0,
        alarms: [],
        active: false,
      },
      ...overrides,
    };
  }

  it("passes valid clocks", () => {
    const clocks = makeClocks({
      calendar: {
        current: 100,
        alarms: [{ id: "a1", fires_at: 200, message: "sunset" }],
        epoch: "campaign start",
        display_format: "day+time",
      },
    });
    expect(validateClocks(clocks)).toHaveLength(0);
  });

  it("errors on negative calendar time", () => {
    const clocks = makeClocks();
    clocks.calendar.current = -10;
    const errors = validateClocks(clocks);
    expect(errors.some((e) => e.message.includes("negative"))).toBe(true);
    expect(errors[0].severity).toBe("error");
  });

  it("warns on past calendar alarm", () => {
    const clocks = makeClocks({
      calendar: {
        current: 100,
        alarms: [{ id: "a1", fires_at: 50, message: "should have fired" }],
        epoch: "campaign start",
        display_format: "day+time",
      },
    });
    const errors = validateClocks(clocks);
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
    expect(errors[0].message).toContain("fires_at");
  });

  it("warns on past combat alarm", () => {
    const clocks = makeClocks({
      combat: {
        current: 5,
        alarms: [{ id: "c1", fires_at: 3, message: "stale" }],
        active: true,
      },
    });
    const errors = validateClocks(clocks);
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
  });

  it("errors on negative combat round", () => {
    const clocks = makeClocks({
      combat: {
        current: -1,
        alarms: [],
        active: true,
      },
    });
    const errors = validateClocks(clocks);
    expect(errors.some((e) => e.message.includes("negative"))).toBe(true);
  });

  it("passes with future alarms on both clocks", () => {
    const clocks = makeClocks({
      calendar: {
        current: 100,
        alarms: [{ id: "a1", fires_at: 200, message: "dawn" }],
        epoch: "campaign start",
        display_format: "day+time",
      },
      combat: {
        current: 3,
        alarms: [{ id: "c1", fires_at: 5, message: "spell ends" }],
        active: true,
      },
    });
    expect(validateClocks(clocks)).toHaveLength(0);
  });
});
