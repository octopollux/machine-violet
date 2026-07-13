import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { ConnectionsPhase } from "./ConnectionsPhase.js";
import type { ConnectionsPhaseProps } from "./ConnectionsPhase.js";
import type { TierAssignmentsResponse } from "../api-client.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";

const DOWN = "[B";
const ENTER = "\r";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<ConnectionsPhaseProps>): ConnectionsPhaseProps {
  const tierAssignments: TierAssignmentsResponse = { large: null, medium: null, small: null };
  return {
    theme: makeTheme(),
    connections: [],
    tierAssignments,
    healthResults: {},
    knownModels: {},
    onAddConnection: vi.fn(),
    onRemoveConnection: vi.fn(),
    onCheckHealth: vi.fn(),
    onSetTier: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

/** Navigate menu → "Add Connection" (index 2) → provider-selection screen. */
async function openProviderPicker(props?: Partial<ConnectionsPhaseProps>) {
  const rendered = render(<ConnectionsPhase {...defaultProps(props)} />);
  // Menu starts at "Connections" (index 0); "Add Connection" is index 2.
  // Space the keystrokes so each stdin data event is parsed and re-rendered
  // independently rather than arriving as one batched chunk.
  const press = async (key: string) => {
    rendered.stdin.write(key);
    await new Promise((r) => setTimeout(r, 20));
  };
  await press(DOWN);
  await press(DOWN);
  await press(ENTER);
  await vi.waitFor(() => {
    expect(rendered.lastFrame()).toContain("Choose provider type");
  });
  return rendered;
}

describe("ConnectionsPhase provider picker", () => {
  it("offers only the validated providers (Anthropic, OpenAI API key)", async () => {
    const { lastFrame } = await openProviderPicker();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("OpenAI (API key)");
  });

  // Regression guard for #712: OpenRouter and Custom (OpenAI-compatible) were
  // pulled from the picker for 1.1 because neither is validated end-to-end.
  // The engine-side adapters still exist, so it's easy to accidentally
  // re-surface them here — this test fails if either row comes back before
  // the post-1.1 validation playtest re-enables it deliberately.
  it("does not offer the unvalidated OpenRouter or Custom providers", async () => {
    const { lastFrame } = await openProviderPicker();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("OpenRouter");
    expect(frame).not.toContain("Custom");
  });
});
