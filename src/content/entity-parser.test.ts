import { parseEntities } from "./entity-parser.js";

describe("parseEntities", () => {
  it("parses a single well-formed entity", () => {
    const raw = `
--- ENTITY ---
Name: Goblin
Category: characters
Slug: goblin

**Type:** Monster
**CR:** 1/4

Small, green, and mean. Goblins attack in packs.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);

    const e = entities[0];
    expect(e.name).toBe("Goblin");
    expect(e.category).toBe("characters");
    expect(e.slug).toBe("goblin");
    expect(e.frontMatter).toEqual({ type: "Monster", cr: "1/4" });
    expect(e.body).toContain("Small, green, and mean");
  });

  it("parses multiple entities from one output", () => {
    const raw = `
--- ENTITY ---
Name: Fireball
Category: rules
Slug: fireball

**Level:** 3
**School:** Evocation

A bright streak flashes to a point you choose.

--- ENTITY ---
Name: Magic Missile
Category: rules
Slug: magic-missile

**Level:** 1
**School:** Evocation

You create three glowing darts of magical force.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("Fireball");
    expect(entities[1].name).toBe("Magic Missile");
  });

  it("skips malformed entities missing required headers", () => {
    const raw = `
--- ENTITY ---
Category: characters

Missing the Name header entirely.

--- ENTITY ---
Name: Valid Entity
Slug: valid-entity

This one is fine.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe("Valid Entity");
  });

  it("defaults category to lore for invalid categories", () => {
    const raw = `
--- ENTITY ---
Name: Strange Thing
Category: not-a-real-category
Slug: strange-thing

Body text.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].category).toBe("lore");
  });

  it("defaults category to lore when missing", () => {
    const raw = `
--- ENTITY ---
Name: Mystery
Slug: mystery

No category given.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].category).toBe("lore");
  });

  it("handles entity with no body", () => {
    const raw = `
--- ENTITY ---
Name: Stub
Category: locations
Slug: stub

**Type:** City
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].body).toBe("");
    expect(entities[0].frontMatter).toEqual({ type: "City" });
  });

  it("handles entity with no front matter", () => {
    const raw = `
--- ENTITY ---
Name: Plain
Category: lore
Slug: plain

Just body text, no front matter lines.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].frontMatter).toEqual({});
    expect(entities[0].body).toContain("Just body text");
  });

  it("passes through sourceSection", () => {
    const raw = `
--- ENTITY ---
Name: Test
Slug: test

Body.
`;
    const entities = parseEntities(raw, "Chapter 3: Monsters");
    expect(entities[0].sourceSection).toBe("Chapter 3: Monsters");
  });

  it("returns empty array for empty input", () => {
    expect(parseEntities("")).toEqual([]);
    expect(parseEntities("   \n\n   ")).toEqual([]);
  });

  it("normalizes front matter keys to snake_case", () => {
    const raw = `
--- ENTITY ---
Name: Test
Slug: test

**Hit Points:** 45
**Armor Class:** 15

Body.
`;
    const entities = parseEntities(raw);
    expect(entities[0].frontMatter).toEqual({
      hit_points: "45",
      armor_class: "15",
    });
  });

  it("skips entity missing slug", () => {
    const raw = `
--- ENTITY ---
Name: No Slug
Category: characters

Body text.
`;
    const entities = parseEntities(raw);
    expect(entities).toHaveLength(0);
  });
});
