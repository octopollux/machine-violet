import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { MainMenuPhase } from "./MainMenuPhase.js";
import type { MainMenuPhaseProps } from "./MainMenuPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<MainMenuPhaseProps>): MainMenuPhaseProps {
  return {
    theme: makeTheme(),
    campaigns: [],
    errorMsg: null,
    apiKeyValid: true,
    onNewCampaign: vi.fn(),
    onResumeCampaign: vi.fn(),
    onArchiveCampaign: vi.fn(),
    onDeleteCampaign: vi.fn(),
    deleteModal: null,
    onConfirmDelete: vi.fn(),
    onCancelDelete: vi.fn(),
    onAddContent: vi.fn(),
    onSettings: vi.fn(),
    onSettingsApiKeys: vi.fn(),
    onQuit: vi.fn(),
    ...overrides,
  };
}

describe("MainMenuPhase", () => {
  it("renders Machine Violet title in top border", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Machine Violet");
  });

  it("renders New Campaign and Quit menu items", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    const frame = lastFrame();
    expect(frame).toContain("New Campaign");
    expect(frame).toContain("Quit");
  });

  it("renders Continue Campaign when campaigns exist", () => {
    const props = defaultProps({
      campaigns: [{ name: "Test Campaign", path: "/tmp/test" }],
    });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    expect(lastFrame()).toContain("Continue Campaign");
  });

  it("does not render Continue Campaign when no campaigns", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    expect(lastFrame()).not.toContain("Continue Campaign");
  });

  it("renders error message when provided", () => {
    const props = defaultProps({ errorMsg: "Something went wrong" });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    expect(lastFrame()).toContain("Something went wrong");
  });

  it("calls onNewCampaign when New Campaign selected", () => {
    const onNewCampaign = vi.fn();
    const { stdin } = render(<MainMenuPhase {...defaultProps({ onNewCampaign })} />);
    stdin.write("\r"); // Enter on first item (New Campaign)
    expect(onNewCampaign).toHaveBeenCalled();
  });

  it("calls onQuit on q key", () => {
    const onQuit = vi.fn();
    const { stdin } = render(<MainMenuPhase {...defaultProps({ onQuit })} />);
    stdin.write("q");
    expect(onQuit).toHaveBeenCalled();
  });

  it("uses themed markers", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    const frame = lastFrame();
    // Selected item should have ◆, others ○
    expect(frame).toContain("◆");
    expect(frame).toContain("○");
  });

  it("renders API Keys in menu when key is invalid", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false })} />);
    expect(lastFrame()).toContain("API Keys");
  });

  it("hides API Keys from menu when key is valid", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: true })} />);
    // API Keys should not appear as a standalone item when key is valid
    // (it's inside Settings instead)
    expect(lastFrame()).not.toContain("API Keys");
  });

  it("renders Settings menu item", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Settings");
  });

  it("blocks New Campaign when apiKeyValid is false", () => {
    const onNewCampaign = vi.fn();
    const { stdin } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false, onNewCampaign })} />);
    // First item is New Campaign — pressing Enter should be blocked
    stdin.write("\r");
    expect(onNewCampaign).not.toHaveBeenCalled();
  });

  it("renders Update Available when updateInfo is provided", () => {
    const props = defaultProps({
      updateInfo: { available: true, currentVersion: "1.0.0", latestVersion: "1.1.0" },
      onUpdate: vi.fn(),
    });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    const frame = lastFrame();
    expect(frame).toContain("Update Available");
    expect(frame).toContain("v1.0.0");
    expect(frame).toContain("v1.1.0");
  });

  it("does not render Update Available when updateInfo is null", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ updateInfo: null })} />);
    expect(lastFrame()).not.toContain("Update Available");
  });

  it("calls onUpdate when Update Available is selected", () => {
    const onUpdate = vi.fn();
    const props = defaultProps({
      updateInfo: { available: true, currentVersion: "1.0.0", latestVersion: "1.1.0" },
      onUpdate,
    });
    const { stdin } = render(<MainMenuPhase {...props} />);
    // Update Available is the first item
    stdin.write("\r");
    expect(onUpdate).toHaveBeenCalled();
  });
});
