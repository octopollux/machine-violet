import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { ArchivedCampaignsPhase } from "./ArchivedCampaignsPhase.js";
import type { ArchivedCampaignsPhaseProps } from "./ArchivedCampaignsPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import type { ArchivedCampaignEntry } from "../config/campaign-archive.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<ArchivedCampaignsPhaseProps>): ArchivedCampaignsPhaseProps {
  return {
    theme: makeTheme(),
    archives: [],
    onUnarchive: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("ArchivedCampaignsPhase", () => {
  it("renders title", () => {
    const { lastFrame } = render(<ArchivedCampaignsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Archived Campaigns");
  });

  it("shows empty message when no archives", () => {
    const { lastFrame } = render(<ArchivedCampaignsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("No archived campaigns");
  });

  it("renders archive entries with names", () => {
    const archives: ArchivedCampaignEntry[] = [
      { name: "My Campaign", zipPath: "/a.zip", archivedDate: "2026-03-20T00:00:00.000Z" },
      { name: "Another", zipPath: "/b.zip", archivedDate: "2026-03-19T00:00:00.000Z" },
    ];
    const { lastFrame } = render(<ArchivedCampaignsPhase {...defaultProps({ archives })} />);
    const frame = lastFrame();
    expect(frame).toContain("My Campaign");
    expect(frame).toContain("Another");
  });

  it("calls onBack on ESC", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<ArchivedCampaignsPhase {...defaultProps({ onBack })} />);
    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("calls onUnarchive on Enter with selected entry", () => {
    const onUnarchive = vi.fn();
    const archives: ArchivedCampaignEntry[] = [
      { name: "My Campaign", zipPath: "/a.zip", archivedDate: "2026-03-20T00:00:00.000Z" },
    ];
    const { stdin } = render(<ArchivedCampaignsPhase {...defaultProps({ archives, onUnarchive })} />);
    stdin.write("\r");
    expect(onUnarchive).toHaveBeenCalledWith(archives[0]);
  });

  it("does not crash on Enter with empty list", () => {
    const onUnarchive = vi.fn();
    const { stdin } = render(<ArchivedCampaignsPhase {...defaultProps({ onUnarchive })} />);
    stdin.write("\r");
    expect(onUnarchive).not.toHaveBeenCalled();
  });

  it("does not crash on arrow keys with empty list", () => {
    const { stdin } = render(<ArchivedCampaignsPhase {...defaultProps()} />);
    // Should not throw
    stdin.write("\u001B[A"); // up arrow
    stdin.write("\u001B[B"); // down arrow
  });
});
