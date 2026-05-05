import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModelConfig, getModel, getEffortConfig, loadPricingConfig } from "./models.js";

describe("model config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mv-model-test-${Date.now()}`);
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

  it("ignores malformed JSON", () => {
    writeFileSync(join(testDir, "dev-config.json"), "not json {{{");
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-opus-4-6");
  });

  it("caches after first load", () => {
    const a = loadModelConfig({ cwd: testDir, reset: true });
    // Write file after first load — should be ignored due to cache
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ effort: { dm: "low" } }),
    );
    const b = loadModelConfig({ cwd: testDir });
    expect(b.effort.dm).toBe(a.effort.dm);
  });

  it("getModel returns tier value", () => {
    loadModelConfig({ cwd: testDir, reset: true });
    expect(getModel("large")).toBe("claude-opus-4-6");
    expect(getModel("medium")).toBe("claude-sonnet-4-6");
    expect(getModel("small")).toBe("claude-haiku-4-5-20251001");
  });

  it("defaults effort with dev high", () => {
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.effort).toEqual({
      "default": null,
      "dm": "high",
      "ooc": "high",
      "setup": "high",
      "dev-mode": "high",
      "ai-player": "low",
      "promote_character": "medium",
      "repair-state": "medium",
    });
  });

  it("loads per-agent effort map from dev-config.json", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ effort: { dm: "high", ooc: "medium" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.effort.dm).toBe("high");
    expect(config.effort.ooc).toBe("medium");
    // default key preserved from DEFAULTS
    expect(config.effort.default).toBeNull();
  });

  it("rejects invalid effort values", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ effort: { dm: "turbo", ooc: "low" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.effort.dm).toBe("high"); // invalid "turbo" rejected, default preserved
    expect(config.effort.ooc).toBe("low");
  });

  it("accepts null/none as disabled effort", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ effort: { dm: null, ooc: "none" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.effort.dm).toBeNull();
    expect(config.effort.ooc).toBeNull();
  });

  it("ignores effort if not an object", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ effort: "high" }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.effort).toEqual({
      "default": null,
      "dm": "high",
      "ooc": "high",
      "setup": "high",
      "dev-mode": "high",
      "ai-player": "low",
      "promote_character": "medium",
      "repair-state": "medium",
    });
  });

  describe("getEffortConfig", () => {
    it("returns null effort for unknown agent with default null", () => {
      loadModelConfig({ cwd: testDir, reset: true });
      const ec = getEffortConfig("unknown-agent");
      expect(ec.effort).toBeNull();
    });

    it("returns high effort for dev by default", () => {
      loadModelConfig({ cwd: testDir, reset: true });
      const ec = getEffortConfig("dev-mode");
      expect(ec.effort).toBe("high");
    });

    it("returns agent-specific config when set", () => {
      writeFileSync(
        join(testDir, "dev-config.json"),
        JSON.stringify({ effort: { dm: "max" } }),
      );
      loadModelConfig({ cwd: testDir, reset: true });
      const ec = getEffortConfig("dm");
      expect(ec.effort).toBe("max");
    });

    it("falls back to 'default' key for unconfigured agents", () => {
      writeFileSync(
        join(testDir, "dev-config.json"),
        JSON.stringify({ effort: { default: "medium" } }),
      );
      loadModelConfig({ cwd: testDir, reset: true });
      const ec = getEffortConfig("scene-summarizer");
      expect(ec.effort).toBe("medium");
    });

    it("agent-specific overrides default", () => {
      writeFileSync(
        join(testDir, "dev-config.json"),
        JSON.stringify({ effort: { default: "high", dm: null } }),
      );
      loadModelConfig({ cwd: testDir, reset: true });
      expect(getEffortConfig("dm").effort).toBeNull();
      expect(getEffortConfig("ooc").effort).toBe("high");
    });
  });
});

describe("pricing config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mv-pricing-test-${Date.now()}`);
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
