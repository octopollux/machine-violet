import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("handles compendium with missing category arrays", () => {
    // Legacy compendiums may lack newer categories (e.g. items)
    const legacy = {
      version: 1 as const,
      lastUpdatedScene: 3,
      characters: [entry({ name: "Oros", slug: "oros", summary: "A PC." })],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
      // items intentionally missing
    } as unknown as Compendium;

    const { lastFrame } = render(
      <Box width={60} height={24}>
        <CompendiumModal
          theme={theme}
          width={60}
          height={24}
          data={legacy}
          onClose={() => {}}
        />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Characters (1)");
    expect(frame).toContain("Items (0)");
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

/** Compendium with cross-referenced entries used to exercise wikilink nav. */
function linkedCompendium(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 5,
    characters: [
      entry({
        name: "Mira",
        slug: "mira",
        summary: "A smuggler who trusts [[Captain Voss]] and despises [[Lord Nemo]].",
      }),
      entry({ name: "Captain Voss", slug: "captain-voss", summary: "Corrupt guard captain who haunts [[Mira]]." }),
    ],
    places: [entry({ name: "The Undercroft", slug: "the-undercroft", summary: "Mira's bolt-hole." })],
    items: [],
    storyline: [],
    lore: [],
    objectives: [],
  };
}

/**
 * Expand the Characters category and open Mira's detail view, so subsequent
 * keypresses exercise the wikilink-navigation code path.
 */
async function openMira(harness: ReturnType<typeof render>): Promise<void> {
  harness.stdin.write("\r"); // expand Characters
  await vi.waitFor(() => expect(harness.lastFrame()!).toContain("Mira"));
  harness.stdin.write("\x1b[B"); // down to Mira
  await vi.waitFor(() => expect(harness.lastFrame()!).toMatch(/\u25C6 Mira/));
  harness.stdin.write("\r"); // open detail
  await vi.waitFor(() => expect(harness.lastFrame()!).toContain("links"));
}

describe("CompendiumModal wikilink navigation", () => {
  it("renders detail view with link count footer when entry has wikilinks", async () => {
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    await openMira(harness);
    // Two wikilinks in Mira's summary \u2014 one live (Captain Voss), one broken (Lord Nemo).
    expect(harness.lastFrame()!).toContain("1/2 links");
  });

  it("cycles selection forward with Tab and back with Shift+Tab", async () => {
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    await openMira(harness);
    expect(harness.lastFrame()!).toContain("1/2 links");
    harness.stdin.write("\t"); // Tab \u2192 next link
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("2/2 links"));
    harness.stdin.write("\t"); // wraps around
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("1/2 links"));
    harness.stdin.write("\x1b[Z"); // Shift+Tab \u2192 wraps backward
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("2/2 links"));
  });

  it("Enter on a live link follows to the target entry", async () => {
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    await openMira(harness);
    // First link is "Captain Voss" \u2014 live.
    harness.stdin.write("\r");
    await vi.waitFor(() => {
      const frame = harness.lastFrame()!;
      expect(frame).toContain("Captain Voss");
      // Captain Voss's summary references Mira \u2014 one link.
      expect(frame).toContain("1/1 links");
    });
  });

  it("Backspace pops the navigation stack", async () => {
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    await openMira(harness);
    harness.stdin.write("\r"); // follow Captain Voss
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("Captain Voss"));
    harness.stdin.write("\x7f"); // Backspace \u2192 back to Mira
    await vi.waitFor(() => {
      const frame = harness.lastFrame()!;
      expect(frame).toContain("Mira");
      expect(frame).toContain("1/2 links");
    });
    harness.stdin.write("\x7f"); // Backspace again \u2192 empty stack \u2192 tree view
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("Characters (2)"));
  });

  it("ESC closes the modal from detail view (not back to tree)", async () => {
    const onClose = vi.fn();
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={onClose}
        />
      </Box>,
    );
    await openMira(harness);
    harness.stdin.write("\x1b"); // ESC
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Enter on a broken link is a no-op (stays on same entry)", async () => {
    const harness = render(
      <Box width={80} height={24}>
        <CompendiumModal
          theme={theme}
          width={80}
          height={24}
          data={linkedCompendium()}
          onClose={() => {}}
        />
      </Box>,
    );
    await openMira(harness);
    harness.stdin.write("\t"); // advance to Lord Nemo (broken)
    await vi.waitFor(() => expect(harness.lastFrame()!).toContain("2/2 links"));
    harness.stdin.write("\r"); // Enter on broken link
    // Wait a tick to give any (unintended) navigation a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.lastFrame()!).toContain("2/2 links");
    expect(harness.lastFrame()!).toContain("Mira");
  });
});

