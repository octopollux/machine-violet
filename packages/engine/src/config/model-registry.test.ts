import { describe, it, expect, beforeEach } from "vitest";
import {
  getKnownModel,
  getMaxOutput,
  getTierDefaults,
  loadModelRegistry,
  supportsImageGeneration,
} from "./model-registry.js";

/**
 * `getMaxOutput` is the single source of truth for `max_tokens` on every API
 * call the engine makes (DM, every subagent, setup, dev, OOC, resolve_session).
 * The original sin behind the GPT-5.5 setup-finalize bug was a too-low cap that
 * truncated tool-call JSON mid-emission. Tests here pin the contract.
 */
describe("getMaxOutput", () => {
  beforeEach(() => {
    loadModelRegistry(undefined, { reset: true });
  });

  it("returns the registry's maxOutput for current Anthropic models", () => {
    expect(getMaxOutput("claude-fable-5")).toBe(128000);
    expect(getMaxOutput("claude-opus-4-8")).toBe(128000);
    expect(getMaxOutput("claude-sonnet-5")).toBe(128000);
  });

  it("returns the registry's maxOutput for GPT-5.5 (the model that triggered this fix)", () => {
    // gpt-5.5 ships with maxOutput=128000 — the largest of any current model.
    // The setup-finalize truncation bug was that we passed 1024, not 128000.
    expect(getMaxOutput("gpt-5.5")).toBe(128000);
  });

  it("returns the fallback for unknown models", () => {
    // Generous fallback so unregistered models don't get truncated; not so
    // high that an out-of-control loop bleeds money before something else
    // catches it.
    const fallback = getMaxOutput("model-that-does-not-exist");
    expect(fallback).toBeGreaterThanOrEqual(8192);
    expect(fallback).toBeLessThanOrEqual(32768);
  });

  it("returns a positive integer for every shipped model", () => {
    // Sanity check: the registry can't ship a broken maxOutput field
    // (zero, negative, NaN) without breaking every API call.
    const registry = loadModelRegistry(undefined, { reset: true });
    for (const id of Object.keys(registry.models)) {
      const max = getMaxOutput(id);
      expect(max, `model ${id}`).toBeGreaterThan(0);
      expect(Number.isInteger(max), `model ${id}`).toBe(true);
    }
  });
});

describe("current provider defaults and metadata", () => {
  beforeEach(() => {
    loadModelRegistry(undefined, { reset: true });
  });

  it("ships the current Anthropic tier family", () => {
    expect(getTierDefaults("anthropic")).toEqual({
      large: "claude-fable-5",
      medium: "claude-sonnet-5",
      small: "claude-haiku-4-5-20251001",
    });
    expect(getKnownModel("claude-fable-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      capabilities: { thinking: true, alwaysAdaptiveThinking: true },
    });
  });

  it("ships GPT-5.6 as the API-key and ChatGPT tier family", () => {
    const expected = {
      large: "gpt-5.6-sol",
      medium: "gpt-5.6-terra",
      small: "gpt-5.6-luna",
    };
    expect(getTierDefaults("openai-apikey")).toEqual(expected);
    expect(getTierDefaults("openai-chatgpt")).toEqual(expected);
  });

  it("uses current OpenAI context and output ceilings", () => {
    expect(getKnownModel("gpt-5.4")).toMatchObject({
      contextWindow: 1_050_000,
      maxOutput: 128_000,
    });
    expect(getKnownModel("gpt-5.4-mini")).toMatchObject({
      contextWindow: 400_000,
      maxOutput: 128_000,
    });
    expect(getKnownModel("gpt-5.4-nano")).toMatchObject({
      contextWindow: 400_000,
      maxOutput: 128_000,
    });
  });
});

describe("supportsImageGeneration", () => {
  beforeEach(() => {
    loadModelRegistry(undefined, { reset: true });
  });

  it("returns true for shipped OpenAI flagship models", () => {
    expect(supportsImageGeneration("gpt-5.5")).toBe(true);
    expect(supportsImageGeneration("gpt-4o")).toBe(true);
  });

  it("returns false for current Anthropic models (no inline image gen yet)", () => {
    expect(supportsImageGeneration("claude-fable-5")).toBe(false);
    expect(supportsImageGeneration("claude-opus-4-8")).toBe(false);
    expect(supportsImageGeneration("claude-sonnet-5")).toBe(false);
    expect(supportsImageGeneration("claude-opus-4-7")).toBe(false);
    expect(supportsImageGeneration("claude-sonnet-4-6")).toBe(false);
    expect(supportsImageGeneration("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("returns false for unknown models — safer default than assuming yes", () => {
    expect(supportsImageGeneration("model-that-does-not-exist")).toBe(false);
  });
});
