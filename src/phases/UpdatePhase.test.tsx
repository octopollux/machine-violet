import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { UpdatePhase } from "./UpdatePhase.js";
import type { UpdatePhaseProps } from "./UpdatePhase.js";
import type { UpdateInfo } from "../config/updater.js";
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

function makeUpdateInfo(overrides?: Partial<UpdateInfo>): UpdateInfo {
  return {
    available: true,
    currentVersion: "0.9.2",
    latestVersion: "0.10.0",
    releaseNotes: "## What's New\n- Feature A\n- Bug fix B",
    ...overrides,
  };
}

function defaultProps(overrides?: Partial<UpdatePhaseProps>): UpdatePhaseProps {
  return {
    theme: makeTheme(),
    updateInfo: makeUpdateInfo(),
    onApply: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("UpdatePhase", () => {
  it("renders Update title in top border", () => {
    const { lastFrame } = render(<UpdatePhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Update");
  });

  it("renders version transition", () => {
    const { lastFrame } = render(<UpdatePhase {...defaultProps()} />);
    const frame = lastFrame();
    expect(frame).toContain("v0.9.2");
    expect(frame).toContain("v0.10.0");
  });

  it("renders release notes", () => {
    const { lastFrame } = render(<UpdatePhase {...defaultProps()} />);
    const frame = lastFrame();
    expect(frame).toContain("Feature A");
    expect(frame).toContain("Bug fix B");
  });

  it("renders Install update and Back options", () => {
    const { lastFrame } = render(<UpdatePhase {...defaultProps()} />);
    const frame = lastFrame();
    expect(frame).toContain("Install update");
    expect(frame).toContain("Back");
  });

  it("calls onApply when Install update selected and Enter pressed", () => {
    const onApply = vi.fn();
    const { stdin } = render(<UpdatePhase {...defaultProps({ onApply })} />);
    // Install update is selected by default (index 0)
    stdin.write("\r");
    expect(onApply).toHaveBeenCalled();
  });

  it("calls onBack when Back selected and Enter pressed", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<UpdatePhase {...defaultProps({ onBack })} />);
    // Navigate down to "Back" using raw escape sequence for down arrow
    stdin.write("\x1B[B");
    // Small delay to let state update
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("calls onBack on ESC", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<UpdatePhase {...defaultProps({ onBack })} />);
    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("renders without release notes", () => {
    const updateInfo = makeUpdateInfo({ releaseNotes: undefined });
    const { lastFrame } = render(<UpdatePhase {...defaultProps({ updateInfo })} />);
    const frame = lastFrame();
    expect(frame).toContain("v0.9.2");
    expect(frame).toContain("Install update");
  });
});
