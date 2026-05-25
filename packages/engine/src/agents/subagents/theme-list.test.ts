import { describe, it, expect, beforeEach } from "vitest";

import {
  listAvailableThemes,
  formatThemesForPrompt,
  resetThemeListCache,
} from "./theme-list.js";

beforeEach(() => {
  resetThemeListCache();
});

describe("listAvailableThemes", () => {
  it("discovers every bundled .theme file", () => {
    const themes = listAvailableThemes();
    expect(themes.length).toBeGreaterThan(10);

    // Spot-check a few canonical themes that should always exist.
    const names = themes.map((t) => t.name);
    expect(names).toContain("gothic");
    expect(names).toContain("arcane");
    expect(names).toContain("terminal");
    expect(names).toContain("clean");
  });

  it("returns themes sorted by name (deterministic)", () => {
    const themes = listAvailableThemes();
    const names = themes.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("parses @genre_tags into a string array", () => {
    const themes = listAvailableThemes();
    const gothic = themes.find((t) => t.name === "gothic");
    expect(gothic).toBeDefined();
    expect(gothic!.genreTags).toContain("grimdark");
    expect(gothic!.genreTags).toContain("horror");
  });

  it("caches the result across calls", () => {
    const first = listAvailableThemes();
    const second = listAvailableThemes();
    expect(second).toBe(first);
  });
});

describe("formatThemesForPrompt", () => {
  it("renders each theme as a bullet with tags", () => {
    const out = formatThemesForPrompt([
      { name: "gothic", genreTags: ["grimdark", "horror"] },
      { name: "terminal", genreTags: ["sci_fi", "cyberpunk"] },
    ]);
    expect(out).toBe("- gothic: grimdark, horror\n- terminal: sci_fi, cyberpunk");
  });

  it("falls back to 'general' when a theme has no tags", () => {
    const out = formatThemesForPrompt([{ name: "blank", genreTags: [] }]);
    expect(out).toBe("- blank: general");
  });
});
