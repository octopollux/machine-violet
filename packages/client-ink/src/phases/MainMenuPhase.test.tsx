import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { MainMenuPhase, wrapByWord } from "./MainMenuPhase.js";
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

  it("wraps long error messages so the banner stays inside the frame (#529)", () => {
    // The verbatim provider error from the session-fatal-recoverable
    // bucket is ~90 chars and used to overflow the frame, producing
    // mangled layout. Wrap at word boundaries; render every wrapped
    // line in full so nothing gets clipped at the right edge.
    const longMsg = "openai-chatgpt connection has no active ChatGPT login. "
      + "Run 'Sign in with ChatGPT' from the Connections menu.";
    const props = defaultProps({ errorMsg: longMsg });
    const frame = render(<MainMenuPhase {...props} />).lastFrame() ?? "";
    // Every word of the message must appear in the output, even though
    // the message itself is longer than the wrap width.
    for (const word of longMsg.split(/\s+/)) {
      expect(frame).toContain(word);
    }
  });

  it("places the error banner above the menu items (#529)", () => {
    // The banner used to sit below the menu; that wasted vertical space
    // on the first thing the player needs to see.
    const props = defaultProps({ errorMsg: "uniqueErrorMarker" });
    const frame = render(<MainMenuPhase {...props} />).lastFrame() ?? "";
    const errorIdx = frame.indexOf("uniqueErrorMarker");
    const menuIdx = frame.indexOf("New Campaign");
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(menuIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(menuIdx);
  });

  it("does not shift the menu when the banner toggles (#529)", () => {
    // The whole point of the topBanner slot: out-of-band messages don't
    // jitter the menu when they appear/disappear. Render the same menu
    // with and without a multi-line wrapped error; the "New Campaign"
    // line must land on the same terminal row in both frames.
    function rowOf(frame: string, marker: string): number {
      return frame.split("\n").findIndex((l) => l.includes(marker));
    }
    const longMsg = "openai-chatgpt connection has no active ChatGPT login. "
      + "Run 'Sign in with ChatGPT' from the Connections menu.";
    const baseline = render(<MainMenuPhase {...defaultProps()} />).lastFrame() ?? "";
    const withBanner = render(
      <MainMenuPhase {...defaultProps({ errorMsg: longMsg })} />,
    ).lastFrame() ?? "";
    expect(rowOf(baseline, "New Campaign"))
      .toBe(rowOf(withBanner, "New Campaign"));
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

  it("hides Add Content when devModeEnabled is false", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ devModeEnabled: false })} />);
    expect(lastFrame()).not.toContain("Add Content");
  });

  it("shows Add Content when devModeEnabled is true", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ devModeEnabled: true })} />);
    expect(lastFrame()).toContain("Add Content");
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

  it("shows a 'Requires a valid API key' hint when items are disabled", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false })} />);
    expect(lastFrame()).toContain("Requires a valid API key");
  });

  it("does not show the disabled hint when the API key is valid", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: true })} />);
    expect(lastFrame()).not.toContain("Requires a valid API key");
  });

  it("renders the disabled hint only once even with multiple disabled items", () => {
    const props = defaultProps({
      apiKeyValid: false,
      campaigns: [{ name: "X", path: "/x" }],
      devModeEnabled: true,
    });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    const frame = lastFrame()!;
    // New Campaign, Continue Campaign, Add Content are all disabled — the hint
    // should appear once total, not once per disabled item.
    const matches = frame.match(/Requires a valid API key/g) ?? [];
    expect(matches.length).toBe(1);
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

describe("wrapByWord", () => {
  it("returns short strings unchanged in a single line", () => {
    expect(wrapByWord("hello world", 80)).toEqual(["hello world"]);
  });

  it("breaks at word boundaries when the line would exceed width", () => {
    expect(wrapByWord("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("emits an over-long single word on its own line rather than splitting it", () => {
    // Splitting a URL / path token in the middle would hurt copy-paste more
    // than wrapping past the edge. Pack what we can, then surrender.
    expect(wrapByWord("short verylongtoken short", 10)).toEqual([
      "short",
      "verylongtoken",
      "short",
    ]);
  });

  it("collapses runs of whitespace", () => {
    expect(wrapByWord("a   b\tc", 80)).toEqual(["a b c"]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(wrapByWord("   ", 80)).toEqual([]);
  });

  it("returns the original text in one line when width is non-positive (defensive)", () => {
    expect(wrapByWord("hello", 0)).toEqual(["hello"]);
    expect(wrapByWord("hello", -5)).toEqual(["hello"]);
  });
});
