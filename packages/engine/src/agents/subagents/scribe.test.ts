import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildScribeToolHandler, splitSections, mergeSectionBodies, sanitizeFrontMatter, buildPrefetchedEntityBlock } from "./scribe.js";
import type { ScribeFileIO } from "./scribe.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { norm } from "../../utils/paths.js";

beforeEach(() => {
  resetPromptCache();
});

function mockFileIO(files: Record<string, string> = {}): ScribeFileIO {
  // Normalize all keys on construction for cross-platform compat
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) store[norm(k)] = v;
  return {
    readFile: vi.fn(async (path: string) => {
      const p = norm(path);
      if (store[p]) return store[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      store[norm(path)] = content;
    }),
    exists: vi.fn(async (path: string) => norm(path) in store),
    listDir: vi.fn(async (path: string) => {
      const prefix = norm(path.endsWith("/") ? path : path + "/");
      const entries = new Set<string>();
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split("/")[0];
          entries.add(first);
        }
      }
      if (entries.size === 0) throw new Error("ENOENT");
      return [...entries];
    }),
    mkdir: vi.fn(async () => {}),
    deleteFile: vi.fn(async (path: string) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete store[norm(path)];
    }),
    rmdir: vi.fn(async (path: string) => {
      // Reject if any keys still live under this directory.
      const prefix = norm(path) + "/";
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) throw new Error("ENOTEMPTY");
      }
    }),
  };
}

describe("buildScribeToolHandler", () => {
  describe("list_entities", () => {
    it("lists character files", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw",
        "/camp/characters/kael.md": "# Kael",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
      const result = await handler("list_entities", { entity_type: "character" });
      expect(result.content).toContain("grimjaw");
      expect(result.content).toContain("kael");
    });

    it("lists location directories", async () => {
      const fio = mockFileIO({
        "/camp/locations/iron-forge/index.md": "# Iron Forge",
        "/camp/locations/dark-forest/index.md": "# Dark Forest",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
      const result = await handler("list_entities", { entity_type: "location" });
      expect(result.content).toContain("iron-forge");
      expect(result.content).toContain("dark-forest");
    });

    it("returns (none) for empty directories", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
      const result = await handler("list_entities", { entity_type: "faction" });
      expect(result.content).toContain("no entities");
    });
  });

  describe("read_entity", () => {
    it("reads an entity file", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n\nA scarred orc.\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
      const result = await handler("read_entity", { entity_type: "character", slug: "grimjaw" });
      expect(result.content).toContain("# Grimjaw");
      expect(result.content).toContain("scarred orc");
    });

    it("returns error for missing entity", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
      const result = await handler("read_entity", { entity_type: "character", slug: "nobody" });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  describe("write_entity (create)", () => {
    it("creates a new character entity", async () => {
      const fio = mockFileIO();
      const created: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 3, created, [], []);

      const result = await handler("write_entity", {
        mode: "create",
        entity_type: "character",
        name: "Grimjaw",
        front_matter: { disposition: "hostile", class: "warrior" },
        body: "A scarred orc chieftain.",
        changelog_entry: "Introduced as rival",
      });

      expect(result.content).toContain("Created");
      expect(result.content).toContain("Grimjaw");
      expect(created).toHaveLength(1);
      expect(created[0]).toContain("grimjaw");

      // Verify written content
      const writeCall = vi.mocked(fio.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("# Grimjaw");
      expect(content).toContain("**Disposition:** hostile");
      expect(content).toContain("scarred orc");
      expect(content).toContain("Scene 003");
      expect(content).toContain("Introduced as rival");
    });

    it("creates a location with parent directory", async () => {
      const fio = mockFileIO();
      const created: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 1, created, [], []);

      await handler("write_entity", {
        mode: "create",
        entity_type: "location",
        name: "Iron Forge",
      });

      expect(fio.mkdir).toHaveBeenCalled();
      expect(created).toHaveLength(1);
    });

    it("creates an item entity in items/ directory", async () => {
      const fio = mockFileIO();
      const created: string[] = [];
      const deltas: { slug: string; name: string; aliases: string[]; type: string; path: string }[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 4, created, [], deltas);

      const result = await handler("write_entity", {
        mode: "create",
        entity_type: "item",
        name: "Crystal Dagger",
        front_matter: { owner: "[[Aldric]]", origin: "[[The Pale Queen]]" },
        body: "A slender blade of translucent crystal.",
        changelog_entry: "Found in the Pale Queen's reliquary",
      });

      expect(result.content).toContain("Created");
      expect(created).toHaveLength(1);
      expect(norm(created[0])).toContain("items/crystal-dagger.md");

      const writeCall = vi.mocked(fio.writeFile).mock.calls[0];
      const writtenPath = writeCall[0] as string;
      const content = writeCall[1] as string;
      expect(norm(writtenPath)).toContain("items/crystal-dagger.md");
      expect(content).toContain("# Crystal Dagger");
      expect(content).toContain("**Type:** item");
      expect(content).toContain("**Owner:** [[Aldric]]");
      expect(content).toContain("**Origin:** [[The Pale Queen]]");
      expect(content).toContain("translucent crystal");
      expect(content).toContain("Scene 004");

      // Verify entity delta
      expect(deltas).toHaveLength(1);
      expect(deltas[0].type).toBe("item");
      expect(deltas[0].name).toBe("Crystal Dagger");
      expect(norm(deltas[0].path)).toContain("items/crystal-dagger.md");
    });

    it("rejects duplicate creation", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);

      const result = await handler("write_entity", {
        mode: "create",
        entity_type: "character",
        name: "Grimjaw",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("already exists");
    });
  });

  describe("write_entity (update)", () => {
    it("updates front matter, appends plain body, adds changelog", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n**Disposition:** hostile\n\nA scarred orc.\n",
      });
      const updated: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 5, [], updated, []);

      const result = await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Grimjaw",
        front_matter: { disposition: "friendly" },
        body: "Now an ally.",
        changelog_entry: "Befriended by Kael",
      });

      expect(result.content).toContain("Updated");
      expect(updated).toHaveLength(1);

      const writeCall = vi.mocked(fio.writeFile).mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain("friendly");
      expect(content).toContain("Now an ally.");
      expect(content).toContain("Scene 005");
      expect(content).toContain("Befriended by Kael");
    });

    it("replaces existing ## sections instead of appending duplicates", async () => {
      const existing = [
        "# Aldric",
        "",
        "**Type:** character",
        "",
        "A brave knight.",
        "",
        "## Inventory",
        "- [[Rusty Sword]]",
        "",
        "## Notes",
        "Prefers diplomacy.",
      ].join("\n");

      const fio = mockFileIO({ "/camp/characters/aldric.md": existing });
      const handler = buildScribeToolHandler(fio, "/camp", 5, [], [], []);

      await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Aldric",
        body: "## Inventory\n- [[Rusty Sword]]\n- [[Crystal Dagger]] — gifted by the Pale Queen",
      });

      const content = vi.mocked(fio.writeFile).mock.calls[0][1] as string;
      // Should have exactly one ## Inventory
      const inventoryCount = (content.match(/## Inventory/g) || []).length;
      expect(inventoryCount).toBe(1);
      // Should contain the updated inventory
      expect(content).toContain("Crystal Dagger");
      // Should preserve the untouched ## Notes section
      expect(content).toContain("## Notes");
      expect(content).toContain("Prefers diplomacy.");
      // Should preserve the preamble
      expect(content).toContain("A brave knight.");
    });

    it("appends genuinely new sections", async () => {
      const existing = [
        "# Aldric",
        "",
        "**Type:** character",
        "",
        "A brave knight.",
        "",
        "## Inventory",
        "- [[Rusty Sword]]",
      ].join("\n");

      const fio = mockFileIO({ "/camp/characters/aldric.md": existing });
      const handler = buildScribeToolHandler(fio, "/camp", 5, [], [], []);

      await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Aldric",
        body: "## Conditions\n- Poisoned (2 rounds remaining)",
      });

      const content = vi.mocked(fio.writeFile).mock.calls[0][1] as string;
      expect(content).toContain("## Inventory");
      expect(content).toContain("## Conditions");
      expect(content).toContain("Poisoned");
      // Inventory should be unchanged
      expect(content).toContain("[[Rusty Sword]]");
    });

    it("handles mixed replace and append in one update", async () => {
      const existing = [
        "# Aldric",
        "",
        "**Type:** character",
        "",
        "A brave knight.",
        "",
        "## Inventory",
        "- [[Rusty Sword]]",
        "",
        "## Notes",
        "Prefers diplomacy.",
      ].join("\n");

      const fio = mockFileIO({ "/camp/characters/aldric.md": existing });
      const handler = buildScribeToolHandler(fio, "/camp", 5, [], [], []);

      await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Aldric",
        body: "## Inventory\n- [[Rusty Sword]]\n- [[Crystal Dagger]]\n\n## Conditions\n- Blessed",
      });

      const content = vi.mocked(fio.writeFile).mock.calls[0][1] as string;
      const inventoryCount = (content.match(/## Inventory/g) || []).length;
      expect(inventoryCount).toBe(1);
      expect(content).toContain("Crystal Dagger");
      expect(content).toContain("## Notes");
      expect(content).toContain("## Conditions");
      expect(content).toContain("Blessed");
    });

    it("deletes front matter keys with null value", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n**Disposition:** hostile\n\nOrc.\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);

      await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Grimjaw",
        front_matter: { disposition: null },
      });

      const content = vi.mocked(fio.writeFile).mock.calls[0][1] as string;
      expect(content).not.toContain("Disposition");
    });

    it("returns error when entity does not exist", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);

      const result = await handler("write_entity", {
        mode: "update",
        entity_type: "character",
        name: "Nobody",
        body: "text",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  it("unescapes literal \\n in body and changelog", async () => {
    const fio = mockFileIO();
    const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);

    await handler("write_entity", {
      mode: "create",
      entity_type: "character",
      name: "Test",
      body: "Line one.\\nLine two.\\n\\nParagraph two.",
      changelog_entry: "Created.\\nWith extra line.",
    });

    const content = vi.mocked(fio.writeFile).mock.calls[0][1] as string;
    expect(content).toContain("Line one.\nLine two.");
    expect(content).toContain("\n\nParagraph two.");
    expect(content).not.toContain("\\n");
  });

  it("returns error when write_entity is called without name", async () => {
    const fio = mockFileIO();
    const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);

    const result = await handler("write_entity", {
      mode: "create",
      entity_type: "character",
      body: "A mysterious figure.",
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("name");
  });

  it("returns error for unknown tool", async () => {
    const fio = mockFileIO();
    const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], []);
    const result = await handler("unknown_tool", {});
    expect(result.is_error).toBe(true);
  });

  describe("rename_entity", () => {
    const placeholder = [
      "# Starting Location",
      "",
      "**Type:** Location",
      "**Placeholder:** true",
      "",
      "_Placeholder._",
      "",
    ].join("\n");

    it("moves the file, updates the H1, rewrites wikilinks, and tracks tree deltas", async () => {
      const fio = mockFileIO({
        "/camp/locations/starting-location/index.md": placeholder,
        "/camp/characters/aldric.md": [
          "# Aldric",
          "",
          "**Type:** character",
          "**Location:** [Starting Location](../locations/starting-location/index.md)",
          "",
          "Met at the [Starting Location](../locations/starting-location/index.md).",
          "",
        ].join("\n"),
      });
      const updated: string[] = [];
      const deltas: { slug: string; name: string; aliases: string[]; type: string; path: string }[] = [];
      const removedSlugs: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 7, [], updated, deltas, removedSlugs);

      const result = await handler("rename_entity", {
        entity_type: "location",
        old_name: "Starting Location",
        new_name: "The Crooked Coin Tavern",
      });

      expect(result.is_error).toBeFalsy();
      expect(result.content).toContain("Renamed");
      expect(result.content).toContain("Crooked Coin Tavern");

      // Old file is gone, new file exists. Note: `slugify` strips leading
      // articles, so "The Crooked Coin Tavern" lands at `crooked-coin-tavern`.
      expect(await fio.exists("/camp/locations/starting-location/index.md")).toBe(false);
      expect(await fio.exists("/camp/locations/crooked-coin-tavern/index.md")).toBe(true);

      // New file has the new H1 + carries the placeholder flag forward
      // (Scribe is supposed to remove `Placeholder:` in a follow-up update.)
      const moved = await fio.readFile("/camp/locations/crooked-coin-tavern/index.md");
      expect(moved).toContain("# The Crooked Coin Tavern");
      expect(moved).toContain("**Placeholder:** true");
      expect(moved).toContain("Renamed from Starting Location to The Crooked Coin Tavern");
      expect(moved).toContain("Scene 007");

      // Wikilinks in aldric.md are rewritten
      const aldric = await fio.readFile("/camp/characters/aldric.md");
      expect(aldric).not.toContain("starting-location");
      expect(aldric).toContain("crooked-coin-tavern");

      // Tree bookkeeping
      expect(removedSlugs).toEqual(["starting-location"]);
      expect(deltas).toHaveLength(1);
      expect(deltas[0].slug).toBe("crooked-coin-tavern");
      expect(deltas[0].name).toBe("The Crooked Coin Tavern");
      expect(deltas[0].type).toBe("location");
      expect(norm(deltas[0].path)).toBe("locations/crooked-coin-tavern/index.md");

      // Old empty location dir was rmdir'd
      expect(fio.rmdir).toHaveBeenCalled();
    });

    it("uses caller-supplied changelog entry when provided", async () => {
      const fio = mockFileIO({ "/camp/locations/starting-location/index.md": placeholder });
      const handler = buildScribeToolHandler(fio, "/camp", 2, [], [], [], []);

      await handler("rename_entity", {
        entity_type: "location",
        old_name: "Starting Location",
        new_name: "Bell Harbor",
        changelog_entry: "Named on entry to the city",
      });

      const moved = await fio.readFile("/camp/locations/bell-harbor/index.md");
      expect(moved).toContain("Named on entry to the city");
      expect(moved).not.toContain("Renamed from Starting Location");
    });

    it("rejects when the target slug already exists", async () => {
      const fio = mockFileIO({
        "/camp/locations/starting-location/index.md": placeholder,
        "/camp/locations/bell-harbor/index.md": "# Bell Harbor\n\n**Type:** Location\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], [], []);

      const result = await handler("rename_entity", {
        entity_type: "location",
        old_name: "Starting Location",
        new_name: "Bell Harbor",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("already exists");
    });

    it("rejects when the source entity does not exist", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], [], []);

      const result = await handler("rename_entity", {
        entity_type: "location",
        old_name: "Nowhere",
        new_name: "Somewhere",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("rejects when both names slugify identically", async () => {
      const fio = mockFileIO({ "/camp/locations/starting-location/index.md": placeholder });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], [], []);

      const result = await handler("rename_entity", {
        entity_type: "location",
        old_name: "Starting Location",
        new_name: "starting-location",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("nothing to rename");
    });

    it("rejects player entities (machine-scope, not campaign-scope)", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], [], []);

      const result = await handler("rename_entity", {
        entity_type: "player",
        old_name: "Alex",
        new_name: "Alexandra",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("player");
    });

    it("rejects when deleteFile is unavailable", async () => {
      const fio = mockFileIO({ "/camp/locations/starting-location/index.md": placeholder });
      fio.deleteFile = undefined;
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], [], [], []);

      const result = await handler("rename_entity", {
        entity_type: "location",
        old_name: "Starting Location",
        new_name: "Bell Harbor",
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("file deletion support");
    });
  });
});

describe("splitSections", () => {
  it("returns single entry for body with no headings", () => {
    const result = splitSections("Just plain text.\n\nAnother paragraph.");
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("");
    expect(result[0].content).toContain("Just plain text.");
  });

  it("splits on ## headings", () => {
    const body = "Preamble.\n\n## Stats\nHP: 42\n\n## Inventory\n- Sword";
    const result = splitSections(body);
    expect(result).toHaveLength(3);
    expect(result[0].heading).toBe("");
    expect(result[0].content).toBe("Preamble.\n");
    expect(result[1].heading).toBe("## Stats");
    expect(result[2].heading).toBe("## Inventory");
  });

  it("does not split on ### headings", () => {
    const body = "## Stats\nHP: 42\n### Substats\nSTR: 10";
    const result = splitSections(body);
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("## Stats");
    expect(result[0].content).toContain("### Substats");
  });
});

describe("mergeSectionBodies", () => {
  it("appends plain text (no headings) for backward compat", () => {
    const result = mergeSectionBodies("Existing text.", "New text.");
    expect(result).toBe("Existing text.\n\nNew text.");
  });

  it("replaces matching section in-place", () => {
    const existing = "## Inventory\n- Sword\n\n## Notes\nBrave.";
    const incoming = "## Inventory\n- Sword\n- Dagger";
    const result = mergeSectionBodies(existing, incoming);
    expect((result.match(/## Inventory/g) || []).length).toBe(1);
    expect(result).toContain("Dagger");
    expect(result).toContain("## Notes");
    expect(result).toContain("Brave.");
  });

  it("preserves preamble text before first heading", () => {
    const existing = "A brave knight.\n\n## Inventory\n- Sword";
    const incoming = "## Inventory\n- Sword\n- Shield";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("A brave knight.");
    expect(result).toContain("Shield");
    expect((result.match(/## Inventory/g) || []).length).toBe(1);
  });

  it("does not overwrite preamble with incoming preamble", () => {
    const existing = "Original description.\n\n## Stats\nHP: 42";
    const incoming = "## Stats\nHP: 30";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("Original description.");
  });

  it("appends incoming body that only has ### headings (no ## sections)", () => {
    const existing = "## Stats\nHP: 42";
    const incoming = "### Substats\nSTR: 10";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("## Stats");
    expect(result).toContain("### Substats");
    expect(result).toContain("STR: 10");
  });
});

describe("sanitizeFrontMatter", () => {
  // These cases all came from route-0 (gpt-5.4-mini scribe). Without the
  // sanitizer they round-trip as `****Type:** character:** character` etc.
  // and the file frontmatter is permanently corrupted.
  it("passes well-formed keys through unchanged", () => {
    const input = {
      type: "character",
      disposition: "friendly",
      location: "[[The Shattered Hall]]",
    };
    expect(sanitizeFrontMatter(input)).toEqual(input);
  });

  it("recovers when the whole `**Key:** Value` line is the JSON key", () => {
    const out = sanitizeFrontMatter({ "**Type:** character": "character" });
    expect(out).toEqual({ type: "character" });
  });

  it("recovers when the value differs from the key fragment (prefers explicit value)", () => {
    // Model sometimes passes the new value separately while still
    // malforming the key — the explicit value should win.
    const out = sanitizeFrontMatter({ "**Disposition:** old": "new" });
    expect(out).toEqual({ disposition: "new" });
  });

  it("handles multiple malformed keys without dropping any", () => {
    const out = sanitizeFrontMatter({
      "**Type:** NPC": "NPC",
      "**Location:** [[US-9]]": "[[US-9]]",
    });
    expect(out).toEqual({ type: "NPC", location: "[[US-9]]" });
  });

  it("lowercases and snake-cases recovered keys to match normalizeKey", () => {
    const out = sanitizeFrontMatter({ "**Additional Names:** Foo, Bar": "Foo, Bar" });
    expect(out).toEqual({ additional_names: "Foo, Bar" });
  });

  it("does not clobber an already-clean key with a malformed duplicate", () => {
    // If both forms are present, the clean key arrives first in
    // Object.entries order; sanitizer must not overwrite it.
    const out = sanitizeFrontMatter({
      type: "character",
      "**Type:** NPC": "NPC",
    });
    expect(out).toEqual({ type: "character" });
  });

  it("preserves null sentinel for key deletion", () => {
    const out = sanitizeFrontMatter({ placeholder: null });
    expect(out).toEqual({ placeholder: null });
  });

  it("preserves null sentinel even when the malformed key carries an old value fragment", () => {
    // Regression for the case Copilot flagged on #481: a model that
    // means to delete a field but also malforms the key would silently
    // resurrect the old value because the recovered fragment looks like
    // information. `null` always means delete — never substitute.
    const out = sanitizeFrontMatter({ "**Location:** [[Old]]": null });
    expect(out).toEqual({ location: null });
  });
});

describe("buildPrefetchedEntityBlock", () => {
  const tree: EntityTree = {
    grimjaw: { name: "Grimjaw", aliases: ["Captain Grimjaw"], type: "character", path: "characters/grimjaw.md" },
    kael: { name: "Kael", aliases: [], type: "character", path: "characters/kael.md" },
  };

  it("prefetches a referenced entity as canonical and excludes the rest", async () => {
    const fio = mockFileIO({
      "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n\nA scarred orc chieftain.",
      "/camp/characters/kael.md": "# Kael\n\nA quiet ranger.",
    });
    const block = await buildPrefetchedEntityBlock(
      [{ visibility: "private", content: "Grimjaw takes 8 damage in the ambush" }],
      tree, "/camp", fio,
    );
    expect(block).toContain("CANONICAL");
    expect(block).toContain("Grimjaw (character)");
    expect(block).toContain("A scarred orc chieftain.");
    expect(block).not.toContain("Kael"); // unreferenced — not prefetched
  });

  it("matches by alias", async () => {
    const fio = mockFileIO({ "/camp/characters/grimjaw.md": "# Grimjaw\n\nbody" });
    const block = await buildPrefetchedEntityBlock(
      [{ visibility: "private", content: "Captain Grimjaw draws his axe" }],
      tree, "/camp", fio,
    );
    expect(block).toContain("Grimjaw (character)");
  });

  it("returns empty when no known entity is referenced", async () => {
    const fio = mockFileIO({ "/camp/characters/grimjaw.md": "# Grimjaw" });
    const block = await buildPrefetchedEntityBlock(
      [{ visibility: "private", content: "A new merchant named Voss appears" }],
      tree, "/camp", fio,
    );
    expect(block).toBe("");
  });

  it("respects word boundaries (no substring matches)", async () => {
    const fio = mockFileIO({ "/camp/characters/kael.md": "# Kael" });
    const block = await buildPrefetchedEntityBlock(
      [{ visibility: "private", content: "Kaeldor the dragon stirs" }], // 'Kael' is a substring, not a word
      tree, "/camp", fio,
    );
    expect(block).toBe("");
  });

  it("skips a referenced entity whose file is missing — the tool fetches it instead", async () => {
    const fio = mockFileIO({}); // grimjaw is in the tree but absent on disk
    const block = await buildPrefetchedEntityBlock(
      [{ visibility: "private", content: "Grimjaw takes 8 damage" }],
      tree, "/camp", fio,
    );
    expect(block).toBe("");
  });
});
