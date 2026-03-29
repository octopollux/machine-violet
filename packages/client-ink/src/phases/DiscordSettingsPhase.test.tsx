import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { DiscordSettingsPhase } from "./DiscordSettingsPhase.js";
import type { DiscordSettingsPhaseProps } from "./DiscordSettingsPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<DiscordSettingsPhaseProps>): DiscordSettingsPhaseProps {
  return {
    theme: makeTheme(),
    currentSetting: null,
    onSave: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("DiscordSettingsPhase", () => {
  it("renders Discord title in top border", () => {
    const { lastFrame } = render(<DiscordSettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Discord");
  });

  it("renders Enable and Disable options", () => {
    const { lastFrame } = render(<DiscordSettingsPhase {...defaultProps()} />);
    const frame = lastFrame();
    expect(frame).toContain("Enable");
    expect(frame).toContain("Disable");
  });

  it("renders description text", () => {
    const { lastFrame } = render(<DiscordSettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Rich Presence");
  });

  it("calls onSave(true) when Enable is selected and Enter pressed", () => {
    const onSave = vi.fn();
    const { stdin } = render(<DiscordSettingsPhase {...defaultProps({ onSave })} />);
    // Enable is selected by default (index 0)
    stdin.write("\r");
    expect(onSave).toHaveBeenCalledWith(true);
  });

  it("calls onSave(false) when Disable is pre-selected via currentSetting", () => {
    const onSave = vi.fn();
    // When currentSetting is false, Disable is pre-selected
    const { stdin } = render(<DiscordSettingsPhase {...defaultProps({ onSave, currentSetting: false })} />);
    stdin.write("\r");
    expect(onSave).toHaveBeenCalledWith(false);
  });

  it("calls onBack on ESC", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<DiscordSettingsPhase {...defaultProps({ onBack })} />);
    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("pre-selects Enable when currentSetting is null", () => {
    const onSave = vi.fn();
    const { stdin } = render(<DiscordSettingsPhase {...defaultProps({ onSave, currentSetting: null })} />);
    stdin.write("\r");
    expect(onSave).toHaveBeenCalledWith(true);
  });
});
