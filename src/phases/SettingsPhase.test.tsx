import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { SettingsPhase } from "./SettingsPhase.js";
import type { SettingsPhaseProps } from "./SettingsPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";
import { resetPromptCache } from "../prompts/load-prompt.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<SettingsPhaseProps>): SettingsPhaseProps {
  return {
    theme: makeTheme(),
    onApiKeys: vi.fn(),
    onDiscord: vi.fn(),
    onArchivedCampaigns: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("SettingsPhase", () => {
  it("renders Settings title in top border", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Settings");
  });

  it("renders API Keys menu item", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("API Keys");
  });

  it("calls onBack on ESC", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<SettingsPhase {...defaultProps({ onBack })} />);
    stdin.write("\u001B"); // ESC
    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("calls onApiKeys when API Keys selected", () => {
    const onApiKeys = vi.fn();
    const { stdin } = render(<SettingsPhase {...defaultProps({ onApiKeys })} />);
    stdin.write("\r"); // Enter on first (and only) item
    expect(onApiKeys).toHaveBeenCalled();
  });

  it("deep-links to API Keys when initialView is set", async () => {
    const onApiKeys = vi.fn();
    render(<SettingsPhase {...defaultProps({ onApiKeys, initialView: "api_keys" })} />);
    // setTimeout(0) is used for the deep-link, so wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(onApiKeys).toHaveBeenCalled();
  });
});
