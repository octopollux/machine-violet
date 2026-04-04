import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildScribeToolHandler, splitSections, mergeSectionBodies } from "./scribe.js";
import type { ScribeFileIO } from "./scribe.js";
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
});
