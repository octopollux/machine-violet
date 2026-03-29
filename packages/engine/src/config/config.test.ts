import { describe, it, expect } from "vitest";
import {
  isConfigured,
  getDefaultHomeDir,
  buildEnvContent,
  buildAppConfig,
  validateApiKeyFormat,
} from "./first-launch.js";
import { PERSONALITIES, getPersonality, randomPersonality } from "./personalities.js";
import { SEEDS, seedsForGenre, randomSeeds } from "./seeds.js";

describe("first-launch", () => {
  it("detects unconfigured state", () => {
    expect(isConfigured("/fake/.env", () => "")).toBe(false);
    expect(isConfigured("/fake/.env", () => { throw new Error("not found"); })).toBe(false);
  });

  it("detects configured state", () => {
    expect(isConfigured("/fake/.env", () => "ANTHROPIC_API_KEY=sk-ant-abc123xyz")).toBe(true);
  });

  it("rejects empty key", () => {
    expect(isConfigured("/fake/.env", () => "ANTHROPIC_API_KEY=")).toBe(false);
  });

  it("returns platform default home dir", () => {
    const dir = getDefaultHomeDir();
    expect(dir).toContain(".machine-violet");
  });

  it("builds .env content", () => {
    const content = buildEnvContent("sk-ant-test123");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-test123");
  });

  it("builds app config JSON", () => {
    const content = buildAppConfig("/home/user/machine-violet");
    const parsed = JSON.parse(content);
    expect(parsed.home_dir).toBe("/home/user/machine-violet");
    expect(parsed.campaigns_dir).toContain("campaigns");
  });

  it("validates API key format", () => {
    expect(validateApiKeyFormat("sk-ant-abcdefghij1234567890")).toBe(true);
    expect(validateApiKeyFormat("invalid-key")).toBe(false);
    expect(validateApiKeyFormat("")).toBe(false);
    expect(validateApiKeyFormat("sk-ant-short")).toBe(false);
  });
});

describe("personalities", () => {
  it("ships personalities", () => {
    expect(PERSONALITIES.length).toBeGreaterThanOrEqual(4);
  });

  it("each personality has name and prompt_fragment", () => {
    for (const p of PERSONALITIES) {
      expect(p.name).toBeTruthy();
      expect(p.prompt_fragment.length).toBeGreaterThan(50);
    }
  });

  it("gets personality by name", () => {
    const chronicler = getPersonality("The Chronicler");
    expect(chronicler).toBeTruthy();
    expect(chronicler!.prompt_fragment).toContain("Chronicler");
  });

  it("returns undefined for unknown personality", () => {
    expect(getPersonality("Unknown")).toBeUndefined();
  });

  it("picks random personality", () => {
    const p = randomPersonality(() => 0);
    expect(PERSONALITIES).toContain(p);
  });
});

describe("seeds", () => {
  it("ships at least 10 seeds", () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(10);
  });

  it("each seed has name, premise, and genres", () => {
    for (const s of SEEDS) {
      expect(s.name).toBeTruthy();
      expect(s.premise).toBeTruthy();
      expect(s.genres.length).toBeGreaterThan(0);
    }
  });

  it("filters by genre", () => {
    const scifi = seedsForGenre("sci-fi");
    expect(scifi.length).toBeGreaterThan(0);
    for (const s of scifi) {
      expect(s.genres).toContain("sci-fi");
    }
  });

  it("picks N random seeds", () => {
    const picks = randomSeeds(3);
    expect(picks).toHaveLength(3);
    // All unique
    const names = new Set(picks.map((s) => s.name));
    expect(names.size).toBe(3);
  });

  it("picks random seeds filtered by genre", () => {
    const picks = randomSeeds(2, "fantasy");
    expect(picks).toHaveLength(2);
    for (const s of picks) {
      expect(s.genres).toContain("fantasy");
    }
  });

  it("handles requesting more seeds than available", () => {
    const picks = randomSeeds(100, "sci-fi");
    expect(picks.length).toBeLessThanOrEqual(SEEDS.length);
    expect(picks.length).toBeGreaterThan(0);
  });
});
