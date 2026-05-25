import { describe, it, expect } from "vitest";
import {
  isConfigured,
  getDefaultHomeDir,
  buildEnvContent,
  buildAppConfig,
  validateApiKeyFormat,
} from "./first-launch.js";

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

// Personality tests moved to personality-loader.test.ts (validates .mvdm files directly).
// Seed tests moved to world-loader.test.ts (validates .mvworld files directly).
