import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { MainMenuPhase } from "./MainMenuPhase.js";
import type { MainMenuPhaseProps } from "./MainMenuPhase.js";
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

function defaultProps(overrides?: Partial<MainMenuPhaseProps>): MainMenuPhaseProps {
  return {
    theme: makeTheme(),
    campaigns: [],
    errorMsg: null,
    apiKeyValid: true,
    onNewCampaign: vi.fn(),
    onResumeCampaign: vi.fn(),
    onAddContent: vi.fn(),
    onApiKeys: vi.fn(),
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

  it("renders API Keys menu item", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("API Keys");
  });

  it("shows 'no valid key' when apiKeyValid is false", () => {
    const props = defaultProps({ apiKeyValid: false });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    expect(lastFrame()).toContain("no valid key");
  });

  it("does not call onNewCampaign when key is invalid", () => {
    const onNewCampaign = vi.fn();
    const { stdin } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false, onNewCampaign })} />);
    stdin.write("\r");
    expect(onNewCampaign).not.toHaveBeenCalled();
  });
});
