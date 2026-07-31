import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { ModelAssignments } from "./ModelAssignments.js";
import type { ModelAssignmentsProps } from "./ModelAssignments.js";
import type { ConnectionInfo } from "../../api-client.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../../tui/themes/index.js";

const ENTER = "\r";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

const anthropicConn: ConnectionInfo = {
  id: "a-1",
  provider: "anthropic",
  label: "Anthropic",
  masked: "***",
  models: [
    { id: "claude-large", displayName: "Claude Large", available: true },
    { id: "claude-small", displayName: "Claude Small", available: true },
  ],
  source: "manual",
  addedAt: "",
};

const otherConn: ConnectionInfo = {
  id: "x-1",
  provider: "xai",
  label: "xAI",
  masked: "***",
  models: [{ id: "grok-4.5", displayName: "Grok 4.5", available: true }],
  source: "manual",
  addedAt: "",
};

function defaultProps(overrides?: Partial<ModelAssignmentsProps>): ModelAssignmentsProps {
  return {
    theme: makeTheme(),
    columns: 100,
    rows: 30,
    connections: [anthropicConn, otherConn],
    tierAssignments: {
      large: { connectionId: "a-1", modelId: "claude-large" },
      medium: { connectionId: "a-1", modelId: "claude-small" },
      small: { connectionId: "a-1", modelId: "claude-small" },
    },
    imageAssignment: null,
    knownModels: {
      "claude-large": { provider: "anthropic", displayName: "Claude Large", contextWindow: 1, maxOutput: 1, defaultTier: "large", pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, capabilities: { thinking: true, tools: true, streaming: true, caching: true } },
      "claude-small": { provider: "anthropic", displayName: "Claude Small", contextWindow: 1, maxOutput: 1, defaultTier: "small", pricing: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, capabilities: { thinking: true, tools: true, streaming: true, caching: true } },
    },
    knownImageModels: {
      "grok-imagine-image": { provider: "xai", displayName: "Grok Imagine" },
      "some-image": { provider: "anthropic", displayName: "Anthropic Image" },
    },
    tierDefaults: { anthropic: { large: "claude-large", medium: "claude-small", small: "claude-small" } },
    onSetTiers: vi.fn(async () => undefined),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("ModelAssignments", () => {
  it("describes tiers by role, not size", () => {
    const { lastFrame } = render(<ModelAssignments {...defaultProps()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("DM narration");
    expect(frame).toContain("Helpers & AI players");
    expect(frame).toContain("Quick tasks");
    expect(frame).toContain("Scene images");
    expect(frame).not.toContain("Large (");
    expect(frame).not.toContain("Medium (");
  });

  it("renders assignments matching the provider default as Auto", () => {
    const { lastFrame } = render(<ModelAssignments {...defaultProps()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Auto (Claude Large)");
    expect(frame).toContain("Auto (Claude Small)");
    expect(frame).toContain("Auto (provider default)");
    expect(frame).not.toContain("override");
  });

  it("marks a non-default assignment as an override", () => {
    const { lastFrame } = render(<ModelAssignments {...defaultProps({
      tierAssignments: {
        large: { connectionId: "a-1", modelId: "claude-small" },
        medium: { connectionId: "a-1", modelId: "claude-small" },
        small: { connectionId: "a-1", modelId: "claude-small" },
      },
    })} />);
    expect(lastFrame()).toContain("Claude Small (override)");
  });

  it("scopes the model picker to the in-use connection only", async () => {
    const rendered = render(<ModelAssignments {...defaultProps()} />);
    rendered.stdin.write(ENTER); // open picker for DM narration
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Auto — Claude Large (recommended)");
      expect(frame).toContain("Claude Small");
      // The xAI connection's models never appear — no cross-provider blending.
      expect(frame).not.toContain("Grok 4.5");
    });
  });

  it("names the scoping connection so the player knows where models come from", () => {
    const { lastFrame } = render(<ModelAssignments {...defaultProps()} />);
    expect(lastFrame()).toContain("Models from Anthropic");
  });
});
