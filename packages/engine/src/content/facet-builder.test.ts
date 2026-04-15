import { buildFacets } from "./facet-builder.js";
import type { FileIO } from "../agents/scene-manager.js";

const norm = (p: string) => p.replace(/\\/g, "/");

function mockIO(initial: Record<string, string> = {}): FileIO & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const key = norm(p);
      for (const [k, v] of Object.entries(files)) {
        if (norm(k) === key) return v;
      }
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async (p: string, c: string) => { files[norm(p)] = c; }),
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

describe("buildFacets", () => {
  it("extracts front matter fields from entity files", async () => {
    const io = mockIO({
      "/home/systems/d-d-5e/entities/monsters/goblin.md": [
        "# Goblin",
        "",
        "**Type:** Humanoid",
        "**CR:** 1/4",
        "**Size:** Small",
        "",
        "Goblins are small, black-hearted creatures.",
      ].join("\n"),
      "/home/systems/d-d-5e/entities/monsters/dragon.md": [
        "# Ancient Red Dragon",
        "",
        "**Type:** Dragon",
        "**CR:** 24",
        "**Size:** Gargantuan",
        "",
        "The most feared of all dragons.",
      ].join("\n"),
    });

    const result = await buildFacets(io, "/home", "d-d-5e");

    expect(result.size).toBe(1);
    const monsters = result.get("monsters")!;
    expect(monsters.category).toBe("monsters");
    expect(monsters.fieldKeys).toEqual(["cr", "size", "type"]);
    expect(monsters.entities).toHaveLength(2);

    const dragon = monsters.entities.find((e) => e.slug === "dragon")!;
    expect(dragon.name).toBe("Ancient Red Dragon");
    expect(dragon.fields.cr).toBe("24");
    expect(dragon.fields.type).toBe("Dragon");

    const goblin = monsters.entities.find((e) => e.slug === "goblin")!;
    expect(goblin.name).toBe("Goblin");
    expect(goblin.fields.cr).toBe("1/4");
  });

  it("writes facets.json for each category", async () => {
    const io = mockIO({
      "/home/systems/d-d-5e/entities/spells/fireball.md": [
        "# Fireball",
        "",
        "**Level:** 3",
        "**School:** Evocation",
        "",
        "A bright streak flashes from your pointing finger.",
      ].join("\n"),
    });

    await buildFacets(io, "/home", "d-d-5e");

    const facetsJson = io.files["/home/systems/d-d-5e/entities/spells/facets.json"];
    expect(facetsJson).toBeDefined();

    const parsed = JSON.parse(facetsJson);
    expect(parsed.category).toBe("spells");
    expect(parsed.fieldKeys).toEqual(["level", "school"]);
    expect(parsed.entities[0].slug).toBe("fireball");
    expect(parsed.entities[0].fields.level).toBe("3");
  });

  it("handles multiple categories", async () => {
    const io = mockIO({
      "/home/systems/test/entities/monsters/orc.md": "# Orc\n\n**CR:** 1\n",
      "/home/systems/test/entities/spells/heal.md": "# Heal\n\n**Level:** 6\n",
      "/home/systems/test/entities/equipment/sword.md": "# Longsword\n\n**Cost:** 15 gp\n",
    });

    const result = await buildFacets(io, "/home", "test");

    expect(result.size).toBe(3);
    expect(result.has("monsters")).toBe(true);
    expect(result.has("spells")).toBe(true);
    expect(result.has("equipment")).toBe(true);
  });

  it("returns empty map when no entities directory exists", async () => {
    const io = mockIO({});
    const result = await buildFacets(io, "/home", "empty");
    expect(result.size).toBe(0);
  });

  it("uses slug as name when no H1 heading present", async () => {
    const io = mockIO({
      "/home/systems/test/entities/lore/history.md": "**Era:** Third Age\n",
    });

    const result = await buildFacets(io, "/home", "test");
    const lore = result.get("lore")!;
    expect(lore.entities[0].name).toBe("history");
    expect(lore.entities[0].fields.era).toBe("Third Age");
  });

  it("normalizes field keys to lowercase with underscores", async () => {
    const io = mockIO({
      "/home/systems/test/entities/chargen/fighter.md": [
        "# Fighter",
        "",
        "**Hit Dice:** d10",
        "**Primary Ability:** Strength",
      ].join("\n"),
    });

    const result = await buildFacets(io, "/home", "test");
    const chargen = result.get("chargen")!;
    expect(chargen.entities[0].fields.hit_dice).toBe("d10");
    expect(chargen.entities[0].fields.primary_ability).toBe("Strength");
  });
});
