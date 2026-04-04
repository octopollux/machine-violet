import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { CompendiumModal } from "./CompendiumModal.js";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import { BUILTIN_DEFINITIONS } from "../themes/builtin-definitions.js";
import type { Compendium, CompendiumEntry } from "@machine-violet/shared/types/compendium.js";

let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

function entry(overrides: Partial<CompendiumEntry> & { name: string; slug: string }): CompendiumEntry {
  return {
    summary: "",
    firstScene: 1,
    lastScene: 1,
    related: [],
    ...overrides,
  };
}

function sampleCompendium(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 5,
    characters: [
      entry({ name: "Mira", slug: "mira", summary: "A smuggler and ally." }),
      entry({ name: "Captain Voss", slug: "captain-voss", summary: "Corrupt guard captain." }),
    ],
    places: [
      entry({ name: "The Undercroft", slug: "the-undercroft", summary: "Hidden tunnel network." }),
    ],
    items: [
      entry({ name: "Crystal Dagger", slug: "crystal-dagger", summary: "A dagger of translucent crystal." }),
    ],
    storyline: [],
    lore: [
      entry({ name: "The Crystal Prophecy", slug: "crystal-prophecy", summary: "An ancient prophecy about the return of the crystal." }),
    ],
    objectives: [
      entry({ name: "Find the Artifact", slug: "find-the-artifact", summary: "Locate the missing relic." }),
    ],
  };
}

function emptyCompendium(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 0,
    characters: [],
    places: [],
    items: [],
    storyline: [],
    lore: [],
    objectives: [],
  };
}

describe("CompendiumModal", () => {
  it("renders empty state message", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <CompendiumModal
          theme={theme}
          width={60}
          height={24}
          data={emptyCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Compendium");
    expect(frame).toContain("No entries yet");
  });

  it("renders category headers with counts", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <CompendiumModal
          theme={theme}
          width={60}
          height={24}
          data={sampleCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Characters (2)");
    expect(frame).toContain("Places (1)");
    expect(frame).toContain("Items (1)");
    expect(frame).toContain("Storyline (0)");
    expect(frame).toContain("Lore (1)");
    expect(frame).toContain("Objectives (1)");
  });

  it("renders title as Compendium", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <CompendiumModal
          theme={theme}
          width={60}
          height={24}
          data={sampleCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    expect(lastFrame()).toContain("Compendium");
  });

  it("renders cursor marker on first row", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <CompendiumModal
          theme={theme}
          width={60}
          height={24}
          data={sampleCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    // First category row should have the selected marker
    expect(lastFrame()).toContain("\u25C6");
  });
});

describe("GameMenu includes Compendium", () => {
  it("shows Compendium in menu items", async () => {
    const { getMenuItems } = await import("./GameMenu.js");
    const items = getMenuItems();
    expect(items).toContain("Compendium");
    // Should be after Character Sheet
    const csIndex = items.indexOf("Character Sheet");
    const compIndex = items.indexOf("Compendium");
    expect(compIndex).toBe(csIndex + 1);
  });
});
