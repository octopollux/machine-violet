import { describe, it, expect, beforeEach } from "vitest";
import { loadPrompt, loadTemplate, resetPromptCache } from "./load-prompt.js";

beforeEach(() => {
  resetPromptCache();
});

const EXPECTED_PROMPTS = [
  "dm-identity",
  "setup-conversation",
  "setup-gen",
  "scene-summarizer",
  "precis-updater",
  "changelog-updater",
  "choice-generator",
  "resolve-action",
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
