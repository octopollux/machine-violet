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

  it("shows a 'Requires a valid API key' hint when items are disabled", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false })} />);
    expect(lastFrame()).toContain("Requires a valid API key");
  });

  it("does not show the disabled hint when the API key is valid", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: true })} />);
    expect(lastFrame()).not.toContain("Requires a valid API key");
  });

  it("defaults the caret to API Keys in no-connection mode (#713)", () => {
    // The disabled "New Campaign" is a dead first stop; the caret should land
    // on the one actionable item instead.
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: false })} />);
    const selected = (lastFrame() ?? "").split("\n").find((l) => l.includes("◆")) ?? "";
    expect(selected).toContain("API Keys");
  });

  it("defaults the caret to API Keys past Continue Campaign / Add Content (#713)", () => {
    // The initial index must track the menu build order — with campaigns and
    // dev mode both present, API Keys sits below those extra items.
    const props = defaultProps({
      apiKeyValid: false,
      campaigns: [{ name: "X", path: "/x" }],
      devModeEnabled: true,
    });
    const { lastFrame } = render(<MainMenuPhase {...props} />);
    const selected = (lastFrame() ?? "").split("\n").find((l) => l.includes("◆")) ?? "";
    expect(selected).toContain("API Keys");
  });

  it("keeps the default caret on New Campaign when the API key is valid (#713)", () => {
    const { lastFrame } = render(<MainMenuPhase {...defaultProps({ apiKeyValid: true })} />);
    const selected = (lastFrame() ?? "").split("\n").find((l) => l.includes("◆")) ?? "";
    expect(selected).toContain("New Campaign");
  });

  it("selects API Keys with Enter on the default caret in no-connection mode (#713)", () => {
    const onSettingsApiKeys = vi.fn();
    const { stdin } = render(
      <MainMenuPhase {...defaultProps({ apiKeyValid: false, onSettingsApiKeys })} />,
    );
    stdin.write("\r"); // Enter on the default (API Keys) item
    expect(onSettingsApiKeys).toHaveBeenCalled();
  });

  it("moves the caret to API Keys when apiKeyValid flips false after mount (#713)", async () => {
    // The real launch path mounts the menu with apiKeyValid=true (optimistic
    // default) and only flips it false once the async connection health check
    // resolves. The caret must follow the mode change, not stay stranded on
    // the now-disabled New Campaign.
    const { rerender, lastFrame } = render(
      <MainMenuPhase {...defaultProps({ apiKeyValid: true })} />,
    );
    const selected = () => (lastFrame() ?? "").split("\n").find((l) => l.includes("◆")) ?? "";
    expect(selected()).toContain("New Campaign");
    rerender(<MainMenuPhase {...defaultProps({ apiKeyValid: false })} />);
    await vi.waitFor(() => expect(selected()).toContain("API Keys"));
  });

  it("tracks the shifting API Keys index when devModeEnabled loads late (#713)", async () => {
    // devModeEnabled also arrives async (getMachineSettings), inserting
    // "Add Content" above API Keys. The default caret must re-resolve to the
    // new API Keys position, not point one row off.
    const { rerender, lastFrame } = render(
      <MainMenuPhase {...defaultProps({ apiKeyValid: false, devModeEnabled: false })} />,
    );
    const selected = () => (lastFrame() ?? "").split("\n").find((l) => l.includes("◆")) ?? "";
    await vi.waitFor(() => expect(selected()).toContain("API Keys"));
    rerender(<MainMenuPhase {...defaultProps({ apiKeyValid: false, devModeEnabled: true })} />);
    await vi.waitFor(() => {
      expect(selected()).toContain("API Keys");
      expect(selected()).not.toContain("Add Content");
    });
  });

  it("does not yank the caret away once the player has navigated (#713)", async () => {
    // If the player has already moved the caret, a late apiKeyValid flip must
    // respect their choice rather than snapping back to API Keys.
    const props = defaultProps({ apiKeyValid: true, campaigns: [{ name: "X", path: "/x" }] });
    const { stdin, rerender, lastFrame } = render(<MainMenuPhase {...props} />);
    const frame = () => lastFrame() ?? "";
    const selected = () => frame().split("\n").find((l) => l.includes("◆")) ?? "";
    const DOWN = "[B";
    // Move down to Continue Campaign — a deliberate caret move.
    await vi.waitFor(() => {
      if (selected().includes("New Campaign")) stdin.write(DOWN);
      expect(selected()).toContain("Continue Campaign");
    });
    // Health check resolves invalid — the caret stays where the player left it.
    rerender(
      <MainMenuPhase {...defaultProps({ apiKeyValid: false, campaigns: [{ name: "X", path: "/x" }] })} />,
    );
    await vi.waitFor(() => {
      expect(frame()).toContain("API Keys"); // item now present…
      expect(selected()).toContain("Continue Campaign"); // …but caret unmoved
    });
  });

  it("collapses the campaign list and advances to the next menu item when scrolling past the end", async () => {
    // Mirror of the up-arrow collapse at the top: down-arrow on the last
    // campaign should close the sub-list and land on the main-menu item
    // *below* Continue Campaign (here, Settings), not clamp in place.
    const props = defaultProps({
      campaigns: [
        { name: "Alpha Campaign", path: "/a" },
        { name: "Beta Campaign", path: "/b" },
      ],
    });
    const { stdin, lastFrame } = render(<MainMenuPhase {...props} />);
    const frame = () => lastFrame() ?? "";
    const selected = () => frame().split("\n").find((l) => l.includes("◆")) ?? "";
    // ink only parses an arrow when the chunk is the real CSI escape
    // sequence (its fnKeyRe requires a leading \x1b); a bare "[B" matches
    // nothing.
    const DOWN = "\u001B[B";

    // ink-testing-library's stdin listener attaches in an effect, and ink
    // re-registers the useInput closure on every commit. A fixed sleep
    // races both, so each step re-sends its key (guarded on the current
    // frame so it can't overshoot — the frame and the live closure are
    // both products of the last commit) until the move is observable.
    await vi.waitFor(() => {
      if (selected().includes("New Campaign")) stdin.write(DOWN);
      expect(selected()).toContain("Continue Campaign");
    });
    await vi.waitFor(() => {
      if (!frame().includes("Alpha Campaign")) stdin.write("\r"); // expand
      expect(frame()).toContain("Alpha Campaign");
    });
    await vi.waitFor(() => {
      if (selected().includes("Alpha Campaign")) stdin.write(DOWN); // to last
      expect(selected()).toContain("Beta Campaign");
    });
    await vi.waitFor(() => {
      if (frame().includes("Alpha Campaign")) stdin.write(DOWN); // past the end
      // Sub-list collapsed (campaign names gone) and selection advanced
      // to the main-menu item below Continue Campaign.
      expect(frame()).not.toContain("Alpha Campaign");
      expect(selected()).toContain("Settings");
    });
  });

  it("clamps campaign selection when several Down events arrive before a re-render (#631)", async () => {
    // A held ↓ can dispatch multiple events against the same useInput
    // closure before React commits. The selection must stay clamped at
    // the last campaign — never run off the end into an undefined entry.
    const onResumeCampaign = vi.fn();
    const props = defaultProps({
      campaigns: [
        { name: "Alpha Campaign", path: "/a" },
        { name: "Beta Campaign", path: "/b" },
        { name: "Gamma Campaign", path: "/c" },
      ],
      onResumeCampaign,
    });
    const { stdin, lastFrame } = render(<MainMenuPhase {...props} />);
    const frame = () => lastFrame() ?? "";
    const selected = () => frame().split("\n").find((l) => l.includes("◆")) ?? "";
    const DOWN = "\u001B[B";

    // Navigate to Continue Campaign and expand (guarded; see sibling test).
    await vi.waitFor(() => {
      if (selected().includes("New Campaign")) stdin.write(DOWN);
      expect(selected()).toContain("Continue Campaign");
    });
    await vi.waitFor(() => {
      if (!frame().includes("Alpha Campaign")) stdin.write("\r"); // expand
      expect(frame()).toContain("Alpha Campaign");
    });

    // Burst: more Down events than there are rows, delivered synchronously
    // so they all hit the same (index 0) closure before any commit.
    stdin.write(DOWN);
    stdin.write(DOWN);
    stdin.write(DOWN);
    stdin.write(DOWN);

    // Selection pins to the last campaign — not an out-of-range index that
    // would leave no row marked and resume an undefined campaign.
    await vi.waitFor(() => {
      expect(frame()).toContain("Gamma Campaign"); // still expanded
      expect(selected()).toContain("Gamma Campaign"); // last row selected
    });
    stdin.write("\r"); // resume the selected campaign
    await vi.waitFor(() => {
      expect(onResumeCampaign).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Gamma Campaign" }),
      );
    });
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

  describe("archive in-flight guard", () => {
    const DOWN = "[B";
    const RIGHT = "[C";

    async function expandList(
      props: MainMenuPhaseProps,
    ): Promise<ReturnType<typeof render>> {
      const r = render(<MainMenuPhase {...props} />);
      const frame = () => r.lastFrame() ?? "";
      const selected = () => frame().split("\n").find((l) => l.includes("◆")) ?? "";
      await vi.waitFor(() => {
        if (selected().includes("New Campaign")) r.stdin.write(DOWN);
        expect(selected()).toContain("Continue Campaign");
      });
      await vi.waitFor(() => {
        if (!frame().includes("Test Campaign")) r.stdin.write("\r"); // expand
        expect(frame()).toContain("Test Campaign");
      });
      return r;
    }

    it("renders 'Archiving…' and hides the action buttons for an in-flight campaign", async () => {
      const props = defaultProps({
        campaigns: [{ name: "Test Campaign", path: "/t" }],
        archivingIds: new Set(["Test Campaign"]),
      });
      const { lastFrame } = await expandList(props);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Archiving");
      // The actionable buttons are replaced while the archive is in flight.
      expect(frame).not.toContain("Delete");
    });

    it("blocks resume/re-archive on a campaign whose archive is in flight", async () => {
      const onArchiveCampaign = vi.fn();
      const onResumeCampaign = vi.fn();
      const props = defaultProps({
        campaigns: [{ name: "Test Campaign", path: "/t" }],
        archivingIds: new Set(["Test Campaign"]),
        onArchiveCampaign,
        onResumeCampaign,
      });
      const { stdin } = await expandList(props);
      // Hammer Enter across columns — every action on an in-flight entry is inert.
      for (let i = 0; i < 3; i++) {
        stdin.write("\r");
        stdin.write(RIGHT);
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(onArchiveCampaign).not.toHaveBeenCalled();
      expect(onResumeCampaign).not.toHaveBeenCalled();
    });

    it("triggers archive and keeps the list expanded for reactive feedback", async () => {
      const onArchiveCampaign = vi.fn();
      const props = defaultProps({
        campaigns: [{ name: "Test Campaign", path: "/t" }],
        onArchiveCampaign,
      });
      const r = await expandList(props);
      const frame = () => r.lastFrame() ?? "";
      await vi.waitFor(() => {
        if (!frame().includes("[Archive]")) r.stdin.write(RIGHT); // to Archive column
        expect(frame()).toContain("[Archive]");
      });
      await vi.waitFor(() => {
        if (!onArchiveCampaign.mock.calls.length) r.stdin.write("\r");
        expect(onArchiveCampaign).toHaveBeenCalled();
      });
      // Unlike resume, archiving does NOT collapse the list — the entry stays
      // visible so the parent can swap in the "Archiving…" state and then drop
      // it on refresh.
      expect(frame()).toContain("Test Campaign");
    });
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
