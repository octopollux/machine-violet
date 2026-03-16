import { describe, it, expect, vi } from "vitest";
import { buildContentSearchToolHandler } from "./search-content.js";
import type { FileIO } from "../scene-manager.js";
import type { CategoryFacets } from "../../types/facets.js";

const norm = (p: string) => p.replace(/\\/g, "/");

function mockIO(initial: Record<string, string> = {}): FileIO {
  const files: Record<string, string> = { ...initial };
  return {
    readFile: vi.fn(async (p: string) => {
      const key = norm(p);
      for (const [k, v] of Object.entries(files)) {
        if (norm(k) === key) return v;
      }
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => {
      const key = norm(p);
      return Object.keys(files).some((k) => {
        const nk = norm(k);
        return nk === key || nk.startsWith(key + "/");
      });
    }),
    listDir: vi.fn(async (p: string) => {
      const dir = norm(p);
      const entries = new Set<string>();
      for (const k of Object.keys(files)) {
        const nk = norm(k);
        if (nk.startsWith(dir + "/")) {
          const rest = nk.slice(dir.length + 1);
          const firstPart = rest.split("/")[0];
          entries.add(firstPart);
        }
      }
      return [...entries];
    }),
  };
}

const MONSTERS_FACETS: CategoryFacets = {
  category: "monsters",
  fieldKeys: ["cr", "size", "type"],
  entities: [
    { slug: "goblin", name: "Goblin", fields: { type: "Humanoid", cr: "1/4", size: "Small" } },
    { slug: "orc", name: "Orc", fields: { type: "Humanoid", cr: "1", size: "Medium" } },
    { slug: "young-red-dragon", name: "Young Red Dragon", fields: { type: "Dragon", cr: "10", size: "Large" } },
    { slug: "ancient-red-dragon", name: "Ancient Red Dragon", fields: { type: "Dragon", cr: "24", size: "Gargantuan" } },
    { slug: "hill-giant", name: "Hill Giant", fields: { type: "Giant", cr: "5", size: "Huge" } },
  ],
};

const SPELLS_FACETS: CategoryFacets = {
  category: "spells",
  fieldKeys: ["level", "school"],
  entities: [
    { slug: "fireball", name: "Fireball", fields: { level: "3", school: "Evocation" } },
    { slug: "cure-wounds", name: "Cure Wounds", fields: { level: "1", school: "Evocation" } },
  ],
};

function buildHandler(extraFiles: Record<string, string> = {}) {
  const io = mockIO({
    "/home/systems/d-d-5e/entities/monsters/facets.json": JSON.stringify(MONSTERS_FACETS),
    "/home/systems/d-d-5e/entities/spells/facets.json": JSON.stringify(SPELLS_FACETS),
    "/home/systems/d-d-5e/entities/monsters/goblin.md": "# Goblin\n\n**Type:** Humanoid\n**CR:** 1/4\n\nA sneaky little creature.",
    ...extraFiles,
  });
  return buildContentSearchToolHandler(io, "/home", "d-d-5e");
}

describe("buildContentSearchToolHandler", () => {
  describe("list_categories", () => {
    it("lists available categories", async () => {
      const handler = buildHandler();
      const result = await handler("list_categories", {});
      const cats = JSON.parse(result.content);
      expect(cats).toContain("monsters");
      expect(cats).toContain("spells");
    });

    it("returns message when no entities dir", async () => {
      const io = mockIO({});
      const handler = buildContentSearchToolHandler(io, "/home", "empty");
      const result = await handler("list_categories", {});
      expect(result.content).toContain("No entities directory");
    });
  });

  describe("search_facets", () => {
    it("filters by substring match", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: { type: "Dragon" },
      });
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("Young Red Dragon");
      expect(parsed[1].name).toBe("Ancient Red Dragon");
    });

    it("filters by numeric range", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: { min_cr: "5", max_cr: "12" },
      });
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toContain("Young Red Dragon");
      expect(names).toContain("Hill Giant");
    });

    it("handles fractional CR (1/4)", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: { max_cr: "1" },
      });
      const parsed = JSON.parse(result.content);
      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toContain("Goblin");  // CR 1/4 = 0.25 ≤ 1
      expect(names).toContain("Orc");     // CR 1 ≤ 1
      expect(names).not.toContain("Hill Giant");
    });

    it("combines substring and numeric filters", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: { type: "Humanoid", min_cr: "1" },
      });
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Orc");
    });

    it("respects limit", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: {},
        limit: 2,
      });
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
    });

    it("returns helpful message for no matches", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "monsters",
        filters: { type: "Celestial" },
      });
      expect(result.content).toContain("No entities match");
      expect(result.content).toContain("cr");
    });

    it("returns error for unknown category", async () => {
      const handler = buildHandler();
      const result = await handler("search_facets", {
        category: "vehicles",
        filters: {},
      });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("No facets index");
    });
  });

  describe("read_entity", () => {
    it("reads full entity content", async () => {
      const handler = buildHandler();
      const result = await handler("read_entity", {
        category: "monsters",
        slug: "goblin",
      });
      expect(result.content).toContain("# Goblin");
      expect(result.content).toContain("sneaky little creature");
    });

    it("returns error for missing entity", async () => {
      const handler = buildHandler();
      const result = await handler("read_entity", {
        category: "monsters",
        slug: "nonexistent",
      });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Entity not found");
    });
  });

  it("returns error for unknown tool", async () => {
    const handler = buildHandler();
    const result = await handler("unknown_tool", {});
    expect(result.is_error).toBe(true);
  });
});
