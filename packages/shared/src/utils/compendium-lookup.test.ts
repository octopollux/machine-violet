import { describe, it, expect } from "vitest";
import {
  findCompendiumEntryBySlug,
  collectCompendiumSlugs,
} from "./compendium-lookup.js";
import type { Compendium, CompendiumEntry } from "../types/compendium.js";

function entry(name: string, slug: string): CompendiumEntry {
  return { name, slug, summary: "", firstScene: 1, lastScene: 1, related: [] };
}

function sample(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 1,
    characters: [entry("Mira", "mira"), entry("Captain Voss", "captain-voss")],
    places: [entry("The Undercroft", "the-undercroft")],
    items: [entry("Crystal Dagger", "crystal-dagger")],
    storyline: [],
    lore: [entry("The Crystal Prophecy", "crystal-prophecy")],
    objectives: [entry("Find the Artifact", "find-the-artifact")],
  };
}

describe("findCompendiumEntryBySlug", () => {
  it("finds an entry across categories", () => {
    const compendium = sample();
    const result = findCompendiumEntryBySlug(compendium, "captain-voss");
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("Captain Voss");
    expect(result!.category).toBe("characters");
  });

  it("finds entries in non-character categories", () => {
    const compendium = sample();
    expect(findCompendiumEntryBySlug(compendium, "the-undercroft")?.category).toBe("places");
    expect(findCompendiumEntryBySlug(compendium, "crystal-prophecy")?.category).toBe("lore");
    expect(findCompendiumEntryBySlug(compendium, "find-the-artifact")?.category).toBe("objectives");
  });

  it("returns null for unknown slug", () => {
    expect(findCompendiumEntryBySlug(sample(), "nonexistent")).toBeNull();
  });

  it("tolerates missing category arrays (legacy compendiums)", () => {
    const legacy = {
      version: 1 as const,
      lastUpdatedScene: 1,
      characters: [entry("Oros", "oros")],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
    } as unknown as Compendium;
    expect(findCompendiumEntryBySlug(legacy, "oros")?.entry.name).toBe("Oros");
    expect(findCompendiumEntryBySlug(legacy, "crystal-dagger")).toBeNull();
  });

  it("returns the first match when slugs duplicate across categories", () => {
    // Pathological but possible: same slug in two categories.
    // Canonical category order (characters first) wins.
    const compendium = sample();
    compendium.places.push(entry("Mira's Hideaway", "mira"));
    const result = findCompendiumEntryBySlug(compendium, "mira");
    expect(result?.category).toBe("characters");
  });
});

describe("collectCompendiumSlugs", () => {
  it("returns every slug from every category", () => {
    const slugs = collectCompendiumSlugs(sample());
    expect(slugs).toEqual(
      new Set([
        "mira",
        "captain-voss",
        "the-undercroft",
        "crystal-dagger",
        "crystal-prophecy",
        "find-the-artifact",
      ]),
    );
  });

  it("returns an empty set for an empty compendium", () => {
    const empty: Compendium = {
      version: 1,
      lastUpdatedScene: 0,
      characters: [],
      places: [],
      items: [],
      storyline: [],
      lore: [],
      objectives: [],
    };
    expect(collectCompendiumSlugs(empty).size).toBe(0);
  });
});
