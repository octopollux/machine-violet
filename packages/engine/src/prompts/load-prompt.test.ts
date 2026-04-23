import { describe, it, expect, beforeEach } from "vitest";
import {
  loadPrompt,
  loadTemplate,
  resetPromptCache,
  stripComments,
} from "./load-prompt.js";

beforeEach(() => {
  resetPromptCache();
});

const EXPECTED_PROMPTS = [
  "dm-identity",
  "dm-directives",
  "setup-conversation",
  "scene-summarizer",
  "precis-updater",
  "changelog-updater",
  "choice-generator",
  "character-promotion",
  "ooc-mode",
  "dev-mode",
  "ai-player",
];

describe("loadPrompt", () => {
  it("loads dm-identity prompt", () => {
    const prompt = loadPrompt("dm-identity");
    expect(prompt).toContain("Dungeon Master");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("caches after first load", () => {
    const a = loadPrompt("dm-identity");
    const b = loadPrompt("dm-identity");
    expect(a).toBe(b); // same reference
  });

  it("throws on missing prompt", () => {
    expect(() => loadPrompt("nonexistent")).toThrow();
  });

  it("normalizes CRLF to LF", () => {
    const prompt = loadPrompt("dm-identity");
    expect(prompt).not.toContain("\r\n");
  });

  it.each(EXPECTED_PROMPTS)("loads %s", (name) => {
    const text = loadPrompt(name);
    expect(text.length).toBeGreaterThan(0);
    expect(typeof text).toBe("string");
  });
});

describe("stripComments", () => {
  it("strips %% line comments", () => {
    const input = "line 1\n%% a comment\nline 2\n";
    expect(stripComments(input)).toBe("line 1\nline 2\n");
  });

  it("strips %% without trailing space", () => {
    expect(stripComments("%%bare comment\nkeep\n")).toBe("keep\n");
  });

  it("strips empty %% lines", () => {
    expect(stripComments("%%\nkeep\n")).toBe("keep\n");
  });

  it("does not strip %% mid-line", () => {
    expect(stripComments("keep %% this\n")).toBe("keep %% this\n");
  });

  it("strips single-line <!-- --> comments", () => {
    const input = "before <!-- gone --> after\n";
    expect(stripComments(input)).toBe("before  after\n");
  });

  it("strips multi-line <!-- --> blocks", () => {
    const input = "before\n<!--\nblock\ncomment\n-->\nafter\n";
    expect(stripComments(input)).toBe("before\n\nafter\n");
  });

  it("strips both %% and <!-- --> together", () => {
    const input = "%% line comment\nbefore\n<!-- block -->\nafter\n";
    expect(stripComments(input)).toBe("before\n\nafter\n");
  });

  it("collapses 3+ blank lines to 2", () => {
    const input = "a\n\n\n\nb\n";
    expect(stripComments(input)).toBe("a\n\nb\n");
  });

  it("passes through text without comments unchanged", () => {
    const input = "no comments here\njust text\n";
    expect(stripComments(input)).toBe(input);
  });
});

describe("loadTemplate", () => {
  it("interpolates {{placeholders}}", () => {
    const result = loadTemplate("ai-player", {
      characterName: "Aldric",
      personality: "\n\nPersonality: Bold and reckless",
      characterSheet: "Fighter, HP 20/20",
      situation: "\n\nCurrent situation: In a cave",
    });
    expect(result).toContain("You are Aldric");
    expect(result).toContain("Bold and reckless");
    expect(result).toContain("Fighter, HP 20/20");
    expect(result).toContain("In a cave");
  });

  it("removes unmatched placeholders", () => {
    const result = loadTemplate("ai-player", {
      characterName: "Test",
      personality: "",
      characterSheet: "Sheet",
      situation: "",
    });
    expect(result).not.toContain("{{");
  });
});
