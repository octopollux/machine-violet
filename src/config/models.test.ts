import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModelConfig, getModel, loadPricingConfig } from "./models.js";

describe("model config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tui-rpg-model-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns defaults when no dev-config.json", () => {
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-opus-4-6");
    expect(config.medium).toBe("claude-sonnet-4-6");
    expect(config.small).toBe("claude-haiku-4-5-20251001");
  });

  it("applies partial override", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ models: { large: "claude-sonnet-4-6" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-sonnet-4-6");
    expect(config.medium).toBe("claude-sonnet-4-6");
    expect(config.small).toBe("claude-haiku-4-5-20251001");
  });

  it("applies full override", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        models: {
          large: "claude-sonnet-4-6",
          medium: "claude-haiku-4-5-20251001",
          small: "claude-haiku-4-5-20251001",
        },
      }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-sonnet-4-6");
    expect(config.medium).toBe("claude-haiku-4-5-20251001");
    expect(config.small).toBe("claude-haiku-4-5-20251001");
  });

  it("ignores malformed JSON", () => {
    writeFileSync(join(testDir, "dev-config.json"), "not json {{{");
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-opus-4-6");
  });

  it("ignores invalid model IDs", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ models: { large: "gpt-4o" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-opus-4-6");
  });

  it("caches after first load", () => {
    const a = loadModelConfig({ cwd: testDir, reset: true });
    // Write file after first load — should be ignored due to cache
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ models: { large: "claude-sonnet-4-6" } }),
    );
    const b = loadModelConfig({ cwd: testDir });
    expect(b.large).toBe(a.large);
  });

  it("getModel returns tier value", () => {
    loadModelConfig({ cwd: testDir, reset: true });
    expect(getModel("large")).toBe("claude-opus-4-6");
    expect(getModel("medium")).toBe("claude-sonnet-4-6");
    expect(getModel("small")).toBe("claude-haiku-4-5-20251001");
  });

  it("defaults thinkingBudget to 0", () => {
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe(0);
  });

  it("loads thinking_budget from dev-config.json", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ thinking_budget: 2048 }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe(2048);
  });

  it("rejects thinking_budget below 1024", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ thinking_budget: 512 }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe(0);
  });

  it("rejects non-integer thinking_budget", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ thinking_budget: 1024.5 }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe(0);
  });

  it("accepts thinking_budget of 0 (disabled)", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ thinking_budget: 0 }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe(0);
  });

  it("accepts thinking_budget 'adaptive'", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ thinking_budget: "adaptive" }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.thinkingBudget).toBe("adaptive");
  });
});

describe("pricing config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tui-rpg-pricing-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns defaults when no dev-config.json", () => {
    const pricing = loadPricingConfig({ cwd: testDir, reset: true });
    expect(pricing["claude-opus-4-6"].input).toBe(5);
    expect(pricing["claude-opus-4-6"].output).toBe(25);
    expect(pricing["claude-haiku-4-5-20251001"].input).toBe(1);
  });

  it("overrides specific model pricing", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        pricing: {
          "claude-opus-4-6": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
        },
      }),
    );
    const pricing = loadPricingConfig({ cwd: testDir, reset: true });
    expect(pricing["claude-opus-4-6"].input).toBe(10);
    expect(pricing["claude-opus-4-6"].output).toBe(50);
    // Other models unchanged
    expect(pricing["claude-haiku-4-5-20251001"].input).toBe(1);
  });

  it("adds pricing for unknown models", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        pricing: {
          "claude-next-gen": { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.8 },
        },
      }),
    );
    const pricing = loadPricingConfig({ cwd: testDir, reset: true });
    expect(pricing["claude-next-gen"].input).toBe(8);
  });

  it("ignores malformed pricing entries", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        pricing: {
          "claude-opus-4-6": { input: "not a number" },
        },
      }),
    );
    const pricing = loadPricingConfig({ cwd: testDir, reset: true });
    // Should still have defaults
    expect(pricing["claude-opus-4-6"].input).toBe(5);
  });

  it("caches after first load", () => {
    const a = loadPricingConfig({ cwd: testDir, reset: true });
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        pricing: {
          "claude-opus-4-6": { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 },
        },
      }),
    );
    const b = loadPricingConfig({ cwd: testDir });
    expect(b["claude-opus-4-6"].input).toBe(a["claude-opus-4-6"].input);
  });
});
