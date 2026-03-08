import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildScribeToolHandler } from "./scribe.js";
import type { ScribeFileIO } from "./scribe.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

beforeEach(() => {
  resetPromptCache();
});

function mockFileIO(files: Record<string, string> = {}): ScribeFileIO {
  const store = { ...files };
  return {
    readFile: vi.fn(async (path: string) => {
      if (store[path]) return store[path];
      throw new Error(`ENOENT: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      store[path] = content;
    }),
    exists: vi.fn(async (path: string) => path in store),
    readdir: vi.fn(async (path: string) => {
      const prefix = path.endsWith("/") ? path : path + "/";
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
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
      const result = await handler("list_entities", { entity_type: "character" });
      expect(result.content).toContain("grimjaw");
      expect(result.content).toContain("kael");
    });

    it("lists location directories", async () => {
      const fio = mockFileIO({
        "/camp/locations/iron-forge/index.md": "# Iron Forge",
        "/camp/locations/dark-forest/index.md": "# Dark Forest",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
      const result = await handler("list_entities", { entity_type: "location" });
      expect(result.content).toContain("iron-forge");
      expect(result.content).toContain("dark-forest");
    });

    it("returns (none) for empty directories", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
      const result = await handler("list_entities", { entity_type: "faction" });
      expect(result.content).toContain("no entities");
    });
  });

  describe("read_entity", () => {
    it("reads an entity file", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n\nA scarred orc.\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
      const result = await handler("read_entity", { entity_type: "character", slug: "grimjaw" });
      expect(result.content).toContain("# Grimjaw");
      expect(result.content).toContain("scarred orc");
    });

    it("returns error for missing entity", async () => {
      const fio = mockFileIO();
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
      const result = await handler("read_entity", { entity_type: "character", slug: "nobody" });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  describe("write_entity (create)", () => {
    it("creates a new character entity", async () => {
      const fio = mockFileIO();
      const created: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 3, created, []);

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
      const handler = buildScribeToolHandler(fio, "/camp", 1, created, []);

      await handler("write_entity", {
        mode: "create",
        entity_type: "location",
        name: "Iron Forge",
      });

      expect(fio.mkdir).toHaveBeenCalled();
      expect(created).toHaveLength(1);
    });

    it("rejects duplicate creation", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);

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
    it("updates front matter, appends body, adds changelog", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n**Disposition:** hostile\n\nA scarred orc.\n",
      });
      const updated: string[] = [];
      const handler = buildScribeToolHandler(fio, "/camp", 5, [], updated);

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

    it("deletes front matter keys with null value", async () => {
      const fio = mockFileIO({
        "/camp/characters/grimjaw.md": "# Grimjaw\n\n**Type:** character\n**Disposition:** hostile\n\nOrc.\n",
      });
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);

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
      const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);

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

  it("returns error for unknown tool", async () => {
    const fio = mockFileIO();
    const handler = buildScribeToolHandler(fio, "/camp", 1, [], []);
    const result = await handler("unknown_tool", {});
    expect(result.is_error).toBe(true);
  });
});
