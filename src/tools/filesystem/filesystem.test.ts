import { describe, it, expect } from "vitest";
import {
  parseFrontMatter,
  serializeEntity,
  extractWikilinks,
  uniqueTargets,
  campaignDirs,
  sceneDir,
  campaignPaths,
  formatChangelogEntry,
  appendChangelog,
  defaultCampaignRoot,
  validateConfig,
  createDefaultCampaignConfig,
} from "./index.js";

// --- Front Matter ---

describe("parseFrontMatter", () => {
  const minimalNpc = `# Brennan the Shopkeeper

**Type:** NPC
**Location:** [Thornfield Village](../locations/thornfield-village/index.md)

Retired soldier, runs a general store. Gruff but fair. Bad knee.

## Changelog
- **Scene 004**: Party bought supplies. Brennan warned them about the caves.
`;

  it("parses title", () => {
    const { frontMatter } = parseFrontMatter(minimalNpc);
    expect(frontMatter._title).toBe("Brennan the Shopkeeper");
  });

  it("parses front matter fields", () => {
    const { frontMatter } = parseFrontMatter(minimalNpc);
    expect(frontMatter.type).toBe("NPC");
    expect(frontMatter.location).toBe(
      "[Thornfield Village](../locations/thornfield-village/index.md)",
    );
  });

  it("extracts body text", () => {
    const { body } = parseFrontMatter(minimalNpc);
    expect(body).toContain("Retired soldier");
    expect(body).toContain("Bad knee");
    expect(body).not.toContain("Changelog");
  });

  it("extracts changelog entries", () => {
    const { changelog } = parseFrontMatter(minimalNpc);
    expect(changelog).toHaveLength(1);
    expect(changelog[0]).toContain("Scene 004");
  });

  it("handles file with no changelog", () => {
    const noChangelog = `# Simple Entity

**Type:** NPC

Just a description.
`;
    const { body, changelog } = parseFrontMatter(noChangelog);
    expect(body).toContain("Just a description");
    expect(changelog).toEqual([]);
  });

  it("extracts additional_names field", () => {
    const entity = `# Mysterious Stranger

**Type:** NPC
**Additional Names:** Grimjaw, Captain Grimjaw

A cloaked figure with a scarred face.
`;
    const { frontMatter } = parseFrontMatter(entity);
    expect(frontMatter.additional_names).toBe("Grimjaw, Captain Grimjaw");
  });

  it("handles multiple changelog entries", () => {
    const multi = `# Mayor Graves

**Type:** NPC

Description.

## Changelog
- **Scene 003**: Met the party.
- **Scene 007**: Confrontation.
- **Scene 012**: Fled town.
`;
    const { changelog } = parseFrontMatter(multi);
    expect(changelog).toHaveLength(3);
    expect(changelog[2]).toContain("Scene 012");
  });

  it("parses full PC character sheet", () => {
    const pc = `# Aldric

**Type:** PC
**Player:** [Alex](../players/alex.md)
**Class:** Paladin 5
**Location:** [Goblin Caves, Level 2](../locations/goblin-caves/index.md)
**Color:** #4488ff
**Display Resources:** HP, Spell Slots, Lay on Hands

Half-elf, folk hero background.

## Stats
STR 16 / DEX 10 / CON 14

## Changelog
- **Scene 001**: Created.
`;
    const { frontMatter, body, changelog } = parseFrontMatter(pc);
    expect(frontMatter.type).toBe("PC");
    expect(frontMatter.player).toBe("[Alex](../players/alex.md)");
    expect(frontMatter.class).toBe("Paladin 5");
    expect(frontMatter.color).toBe("#4488ff");
    expect(frontMatter.display_resources).toBe("HP, Spell Slots, Lay on Hands");
    expect(body).toContain("Half-elf");
    expect(body).toContain("## Stats");
    expect(changelog).toHaveLength(1);
  });
});

describe("serializeEntity", () => {
  it("round-trips a minimal entity", () => {
    const title = "Brennan";
    const fm = { type: "NPC", location: "Thornfield" };
    const body = "Retired soldier.";
    const changelog = ["**Scene 004**: Bought supplies."];

    const md = serializeEntity(title, fm, body, changelog);
    expect(md).toContain("# Brennan");
    expect(md).toContain("**Type:** NPC");
    expect(md).toContain("**Location:** Thornfield");
    expect(md).toContain("Retired soldier.");
    expect(md).toContain("## Changelog");
    expect(md).toContain("- **Scene 004**: Bought supplies.");
  });

  it("skips internal keys", () => {
    const md = serializeEntity("Test", { _title: "Test", type: "NPC" }, "", []);
    expect(md).not.toContain("_title");
    expect(md).toContain("**Type:** NPC");
  });

  it("round-trips additional_names", () => {
    const md = serializeEntity(
      "Mysterious Stranger",
      { type: "NPC", additional_names: "Grimjaw, Captain Grimjaw" },
      "A cloaked figure.",
      [],
    );
    expect(md).toContain("**Additional Names:** Grimjaw, Captain Grimjaw");
    const { frontMatter } = parseFrontMatter(md);
    expect(frontMatter.additional_names).toBe("Grimjaw, Captain Grimjaw");
  });

  it("handles empty body and changelog", () => {
    const md = serializeEntity("Empty", { type: "NPC" }, "", []);
    expect(md).toContain("# Empty");
    expect(md).toContain("**Type:** NPC");
    expect(md).not.toContain("## Changelog");
  });
});

// --- Wikilinks ---

describe("extractWikilinks", () => {
  it("extracts markdown links to .md files", () => {
    const md = `Met [Aldric](../characters/aldric.md) at the [Rusty Nail](../locations/rusty-nail/index.md).`;
    const links = extractWikilinks(md);
    expect(links).toHaveLength(2);
    expect(links[0].display).toBe("Aldric");
    expect(links[0].target).toBe("../characters/aldric.md");
    expect(links[1].display).toBe("Rusty Nail");
  });

  it("extracts links to .json files", () => {
    const md = `See [map](../locations/caves/level-1.json) for details.`;
    const links = extractWikilinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].target).toContain(".json");
  });

  it("tracks line numbers", () => {
    const md = `Line one.\n[Link](file.md) on line two.\nLine three.\n[Another](other.md) on line four.`;
    const links = extractWikilinks(md);
    expect(links[0].line).toBe(2);
    expect(links[1].line).toBe(4);
  });

  it("finds multiple links on one line", () => {
    const md = `[A](a.md) and [B](b.md) and [C](c.md)`;
    const links = extractWikilinks(md);
    expect(links).toHaveLength(3);
  });

  it("ignores non-.md/.json links", () => {
    const md = `[site](https://example.com) and [image](pic.png)`;
    const links = extractWikilinks(md);
    expect(links).toHaveLength(0);
  });

  it("returns empty for no links", () => {
    expect(extractWikilinks("No links here.")).toEqual([]);
  });
});

describe("uniqueTargets", () => {
  it("deduplicates link targets", () => {
    const links = [
      { display: "A", target: "a.md", line: 1 },
      { display: "A again", target: "a.md", line: 2 },
      { display: "B", target: "b.md", line: 3 },
    ];
    expect(uniqueTargets(links)).toEqual(["a.md", "b.md"]);
  });
});

// --- Scaffold ---

// Normalize path separators for cross-platform assertions
import { norm } from "../../utils/paths.js";

describe("campaignDirs", () => {
  it("returns all expected directories", () => {
    const dirs = campaignDirs("/root").map(norm);
    expect(dirs).toContain("/root");
    expect(dirs).toContain("/root/campaign");
    expect(dirs).toContain("/root/campaign/scenes");
    expect(dirs).toContain("/root/campaign/session-recaps");
    expect(dirs).toContain("/root/players");
    expect(dirs).toContain("/root/characters");
    expect(dirs).toContain("/root/locations");
    expect(dirs).toContain("/root/factions");
    expect(dirs).toContain("/root/lore");
    expect(dirs).toContain("/root/rules");
    expect(dirs).toContain("/root/state");
    expect(dirs).toHaveLength(11);
  });
});

describe("sceneDir", () => {
  it("pads scene number to 3 digits", () => {
    const dir = norm(sceneDir("/root", 1, "tavern-meeting"));
    expect(dir).toContain("001-tavern-meeting");
  });

  it("handles larger scene numbers", () => {
    const dir = norm(sceneDir("/root", 42, "big-fight"));
    expect(dir).toContain("042-big-fight");
  });
});

describe("campaignPaths", () => {
  it("generates correct file paths", () => {
    const paths = campaignPaths("/root");
    expect(norm(paths.config)).toContain("config.json");
    expect(norm(paths.log)).toContain("campaign/log.md");
    expect(norm(paths.character("aldric"))).toContain("characters/aldric.md");
    expect(norm(paths.player("alex"))).toContain("players/alex.md");
    expect(norm(paths.location("caves"))).toContain("locations/caves/index.md");
    expect(norm(paths.locationMap("caves", "level-1"))).toContain("locations/caves/level-1.json");
    expect(norm(paths.faction("guild"))).toContain("factions/guild.md");
    expect(norm(paths.lore("sword"))).toContain("lore/sword.md");
    expect(norm(paths.rule("combat"))).toContain("rules/combat.md");
    expect(norm(paths.sessionRecap(2))).toContain("session-recaps/session-002.md");
    expect(norm(paths.sceneTranscript(1, "tavern"))).toContain("001-tavern/transcript.md");
    expect(norm(paths.sceneDmNotes(1, "tavern"))).toContain("001-tavern/dm-notes.md");
  });
});

// --- Changelog ---

describe("formatChangelogEntry", () => {
  it("formats with padded scene number", () => {
    const entry = formatChangelogEntry(4, "Bought supplies.");
    expect(entry).toBe("**Scene 004**: Bought supplies.");
  });

  it("handles larger scene numbers", () => {
    const entry = formatChangelogEntry(42, "Big fight.");
    expect(entry).toBe("**Scene 042**: Big fight.");
  });
});

describe("appendChangelog", () => {
  it("appends to existing changelog", () => {
    const md = `# Test

Description.

## Changelog
- **Scene 001**: Created.
`;
    const result = appendChangelog(md, "**Scene 002**: Updated.");
    expect(result).toContain("- **Scene 001**: Created.");
    expect(result).toContain("- **Scene 002**: Updated.");
  });

  it("creates changelog section when none exists", () => {
    const md = `# Test

Description.
`;
    const result = appendChangelog(md, "**Scene 001**: Created.");
    expect(result).toContain("## Changelog");
    expect(result).toContain("- **Scene 001**: Created.");
  });

  it("appends after multiple existing entries", () => {
    const md = `# Test

## Changelog
- **Scene 001**: First.
- **Scene 002**: Second.
`;
    const result = appendChangelog(md, "**Scene 003**: Third.");
    expect(result).toContain("- **Scene 003**: Third.");
    // Check order is preserved
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("Scene 003");
  });
});

// --- Platform ---

describe("defaultCampaignRoot", () => {
  it("returns Documents path for Windows", () => {
    const root = defaultCampaignRoot("win32");
    expect(root).toContain("Documents");
    expect(root).toContain(".tui-rpg");
  });

  it("returns Documents path for macOS", () => {
    const root = defaultCampaignRoot("darwin");
    expect(root).toContain("Documents");
    expect(root).toContain(".tui-rpg");
  });

  it("returns XDG or .local/share for Linux", () => {
    const root = norm(defaultCampaignRoot("linux"));
    expect(root).toContain(".tui-rpg");
    // Should be either XDG_DATA_HOME or .local/share
    const xdg = process.env["XDG_DATA_HOME"];
    const hasXdg = xdg ? root.includes(norm(xdg)) : false;
    const hasLocal = root.includes(".local/share");
    expect(hasXdg || hasLocal).toBe(true);
  });
});

// --- Config ---

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    expect(validateConfig(config)).toEqual([]);
  });

  it("rejects non-object", () => {
    expect(validateConfig("string")).toContain("Config must be an object");
    expect(validateConfig(null)).toContain("Config must be an object");
  });

  it("requires name", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    (config as Record<string, unknown>).name = "";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("requires dm_personality", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    (config as Record<string, unknown>).dm_personality = undefined;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("dm_personality"))).toBe(true);
  });

  it("requires players", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    config.players = [];
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("players"))).toBe(true);
  });

  it("validates player entries", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    config.players = [{ name: "Alex", character: "aldric", type: "robot" as "human" }];
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("type"))).toBe(true);
  });

  it("validates combat config", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    (config.combat as Record<string, unknown>).initiative_method = "invalid";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("initiative_method"))).toBe(true);
  });

  it("validates choices config", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    (config.choices as Record<string, unknown>).campaign_default = "sometimes";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("campaign_default"))).toBe(true);
  });
});

describe("createDefaultCampaignConfig", () => {
  it("creates a valid default config", () => {
    const config = createDefaultCampaignConfig("My Campaign", "Alex", "aldric");
    expect(config.name).toBe("My Campaign");
    expect(config.players).toHaveLength(1);
    expect(config.players[0].name).toBe("Alex");
    expect(config.players[0].character).toBe("aldric");
    expect(config.combat.initiative_method).toBe("d20_dex");
    expect(validateConfig(config)).toEqual([]);
  });

  it("includes version and createdAt", () => {
    const config = createDefaultCampaignConfig("Test", "Alex", "aldric");
    expect(config.version).toBe(1);
    expect(config.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
