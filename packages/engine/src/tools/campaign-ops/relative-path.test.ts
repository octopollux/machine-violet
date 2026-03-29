import { describe, it, expect } from "vitest";
import { computeRelativePath } from "./relative-path.js";

describe("computeRelativePath", () => {
  it("computes path from nested scene transcript to characters", () => {
    expect(
      computeRelativePath(
        "campaign/scenes/001-tavern/transcript.md",
        "characters/kael.md",
      ),
    ).toBe("../../../characters/kael.md");
  });

  it("computes path between sibling files", () => {
    expect(
      computeRelativePath("characters/kael.md", "characters/goblin.md"),
    ).toBe("goblin.md");
  });

  it("computes path from root-level file to nested file", () => {
    expect(
      computeRelativePath("campaign/log.md", "characters/kael.md"),
    ).toBe("../characters/kael.md");
  });

  it("computes path between different top-level dirs", () => {
    expect(
      computeRelativePath("locations/tavern/index.md", "factions/thieves-guild.md"),
    ).toBe("../../factions/thieves-guild.md");
  });

  it("computes path from deeper to shallower nesting", () => {
    expect(
      computeRelativePath(
        "campaign/scenes/002-forest/dm-notes.md",
        "campaign/log.md",
      ),
    ).toBe("../../log.md");
  });

  it("computes same-directory path (file in root)", () => {
    expect(
      computeRelativePath("readme.md", "config.json"),
    ).toBe("config.json");
  });

  it("roundtrips with resolveRelativePath logic", () => {
    // Manually resolve to verify: from "characters/kael.md" dir = ["characters"]
    // relative = "../locations/tavern.md" → pop "characters" → push "locations", "tavern.md"
    // result = "locations/tavern.md" ✓
    const result = computeRelativePath("characters/kael.md", "locations/tavern.md");
    expect(result).toBe("../locations/tavern.md");
  });
});
