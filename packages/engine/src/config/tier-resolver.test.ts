import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTierProviders } from "./tier-resolver.js";
import { loadModelConfig, getModel } from "./models.js";
import { createAnthropicProvider } from "../providers/anthropic.js";
import type { ConnectionStore } from "./connections.js";

/**
 * The whole point of TierProvider is heterogeneous routing — sending each
 * tier's call through the connection assigned to that tier, even when tiers
 * span vendors. These tests pin that contract: if anyone refactors
 * connections.ts or the provider factory and breaks the Large=OpenAI /
 * Medium=Anthropic case, the breakage shows up here rather than at runtime
 * with a confused vendor rejecting a foreign model ID.
 */
describe("buildTierProviders", () => {
  beforeEach(() => {
    // getModel is the fallback path; reset to canonical defaults.
    loadModelConfig({ reset: true });
  });

  it("routes each tier through its assigned connection in a heterogeneous setup", () => {
    const store: ConnectionStore = {
      connections: [
        { id: "openai-1", provider: "openai", label: "OpenAI", apiKey: "sk-test", models: [], source: "manual", addedAt: "" },
        { id: "anthropic-1", provider: "anthropic", label: "Anthropic", apiKey: "sk-ant-test", models: [], source: "manual", addedAt: "" },
      ],
      tierAssignments: {
        large: { connectionId: "openai-1", modelId: "gpt-5.5" },
        medium: { connectionId: "anthropic-1", modelId: "claude-sonnet-4-6" },
        small: { connectionId: "anthropic-1", modelId: "claude-haiku-4-5-20251001" },
      },
    };
    const fallbackThunk = vi.fn(() => createAnthropicProvider("sk-fallback"));

    const tiers = buildTierProviders(store, fallbackThunk);

    expect(tiers.large.model).toBe("gpt-5.5");
    expect(tiers.large.provider.providerId).toBe("openai");
    expect(tiers.medium.model).toBe("claude-sonnet-4-6");
    expect(tiers.medium.provider.providerId).toBe("anthropic");
    expect(tiers.small.model).toBe("claude-haiku-4-5-20251001");
    expect(tiers.small.provider.providerId).toBe("anthropic");

    // Two tiers sharing a connection share the underlying client.
    expect(tiers.medium.provider).toBe(tiers.small.provider);
    // Different connections produce different clients.
    expect(tiers.large.provider).not.toBe(tiers.medium.provider);

    // Fallback thunk untouched — every tier resolved via assignment.
    expect(fallbackThunk).not.toHaveBeenCalled();
  });

  it("falls back to the thunk for unassigned tiers and invokes it lazily once", () => {
    const store: ConnectionStore = {
      connections: [],
      tierAssignments: { large: null, medium: null, small: null },
    };
    const fallback = createAnthropicProvider("sk-fallback");
    const fallbackThunk = vi.fn(() => fallback);

    const tiers = buildTierProviders(store, fallbackThunk);

    expect(tiers.large.provider).toBe(fallback);
    expect(tiers.medium.provider).toBe(fallback);
    expect(tiers.small.provider).toBe(fallback);
    expect(tiers.large.model).toBe(getModel("large"));
    expect(tiers.medium.model).toBe(getModel("medium"));
    expect(tiers.small.model).toBe(getModel("small"));

    // Three fallback resolutions, one thunk invocation.
    expect(fallbackThunk).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the fallback thunk when every tier is assigned", () => {
    const store: ConnectionStore = {
      connections: [
        { id: "openai-1", provider: "openai", label: "OpenAI", apiKey: "sk-test", models: [], source: "manual", addedAt: "" },
      ],
      tierAssignments: {
        large: { connectionId: "openai-1", modelId: "gpt-5.5" },
        medium: { connectionId: "openai-1", modelId: "gpt-5.5" },
        small: { connectionId: "openai-1", modelId: "gpt-5.5" },
      },
    };
    const fallbackThunk = vi.fn(() => createAnthropicProvider("sk-fallback"));

    buildTierProviders(store, fallbackThunk);

    expect(fallbackThunk).not.toHaveBeenCalled();
  });

  it("falls back when an assignment references a connection that no longer exists", () => {
    // getTierProvider treats a stale connectionId as null, so we route to
    // fallback rather than throw — this is the recovery path for a removed
    // connection that hasn't been re-resolved yet.
    const store: ConnectionStore = {
      connections: [],
      tierAssignments: {
        large: { connectionId: "ghost", modelId: "gpt-5.5" },
        medium: null,
        small: null,
      },
    };
    const fallback = createAnthropicProvider("sk-fallback");
    const fallbackThunk = vi.fn(() => fallback);

    const tiers = buildTierProviders(store, fallbackThunk);

    expect(tiers.large.provider).toBe(fallback);
    expect(tiers.large.model).toBe(getModel("large"));
  });
});
