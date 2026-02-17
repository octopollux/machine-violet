import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModelConfig, getModel } from "./models.js";

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
    expect(config.medium).toBe("claude-sonnet-4-5-20250929");
    expect(config.small).toBe("claude-haiku-4-5-20251001");
  });

  it("applies partial override", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({ models: { large: "claude-sonnet-4-5-20250929" } }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-sonnet-4-5-20250929");
    expect(config.medium).toBe("claude-sonnet-4-5-20250929");
    expect(config.small).toBe("claude-haiku-4-5-20251001");
  });

  it("applies full override", () => {
    writeFileSync(
      join(testDir, "dev-config.json"),
      JSON.stringify({
        models: {
          large: "claude-sonnet-4-5-20250929",
          medium: "claude-haiku-4-5-20251001",
          small: "claude-haiku-4-5-20251001",
        },
      }),
    );
    const config = loadModelConfig({ cwd: testDir, reset: true });
    expect(config.large).toBe("claude-sonnet-4-5-20250929");
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
      JSON.stringify({ models: { large: "claude-sonnet-4-5-20250929" } }),
    );
    const b = loadModelConfig({ cwd: testDir });
    expect(b.large).toBe(a.large);
  });

  it("getModel returns tier value", () => {
    loadModelConfig({ cwd: testDir, reset: true });
    expect(getModel("large")).toBe("claude-opus-4-6");
    expect(getModel("medium")).toBe("claude-sonnet-4-5-20250929");
    expect(getModel("small")).toBe("claude-haiku-4-5-20251001");
  });
});
