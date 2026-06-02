import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { Modal } from "./Modal.js";
import { ChoiceModal, ChoiceOverlay } from "./ChoiceModal.js";
import { GameMenu } from "./GameMenu.js";
import type { MenuGroup } from "./GameMenu.js";
import { CharacterSheetModal } from "./CharacterSheetModal.js";
import { SessionRecapModal } from "./SessionRecapModal.js";
import { SwatchModal } from "./SwatchModal.js";
import { RollbackPickerModal } from "./RollbackPickerModal.js";
import { RollbackConfirmModal } from "./RollbackConfirmModal.js";
import type { Savepoint } from "@machine-violet/shared";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import { BUILTIN_DEFINITIONS } from "../themes/builtin-definitions.js";
import { getStyle } from "../frames/index.js";

// Old-style variant still needed for ChoiceModal (legacy component)
const gothic = getStyle("gothic")!.variants.exploration;

// Resolved theme for all modernized modals
let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

describe("Modal", () => {
  it("renders border and content", () => {
    const { lastFrame } = render(
      <Modal theme={theme} width={40} lines={["Hello world"]} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Hello world");
  });

  it("renders title in top border", () => {
    const { lastFrame } = render(
      <Modal theme={theme} width={40} title="Test" lines={["Body"]} />,
    );
    expect(lastFrame()).toContain("Test");
  });
});

describe("ChoiceModal", () => {
  it("renders prompt and labeled choices with selection cursor", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={50}
        prompt="What do you do?"
        choices={["Attack", "Flee", "Negotiate"]}
        selectedIndex={0}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("What do you do?");
    expect(frame).toContain("> Attack");
    expect(frame).toContain("  Flee");
    expect(frame).toContain("  Negotiate");
  });

  it("renders without custom input row when showCustomInput is omitted", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={50}
        prompt="Pick one"
        choices={["A", "B"]}
        selectedIndex={0}
      />,
    );
    expect(lastFrame()).not.toContain("Enter your own");
  });

  it("renders Enter your own text when showCustomInput is true", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        selectedIndex={0}
        showCustomInput
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Enter your own...");
    expect(frame).toContain("  Enter your own...");
  });

  it("highlights custom input row when selected", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        selectedIndex={2}
        showCustomInput
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("> Enter your own...");
  });

  it("renders inline text input when customInputActive is true", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        selectedIndex={2}
        showCustomInput
        customInputActive
        customInputResetKey={0}
        onCustomInputSubmit={() => {}}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("> Enter your own:");
    expect(frame).toContain("Type your action");
  });
});

const noop = () => {};

describe("ChoiceOverlay", () => {
  it("renders prompt and choices without frame borders", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee", "Negotiate"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("What do you do?");
    expect(frame).toContain("> Attack");
    expect(frame).toContain("  Flee");
    expect(frame).toContain("  Negotiate");
    // No frame borders
    expect(frame).not.toContain("╔");
    expect(frame).not.toContain("╚");
  });

  it("shows scroll arrows in left margin when scrollable", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B", "C", "D", "E", "F", "G"]}
        initialIndex={6}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("▲");
    expect(frame).toContain("▼");
  });

  it("moves cursor within visible window without scrolling", async () => {
    // 7 choices + custom = 8 items, choiceRows=5.
    // Press UP from the bottom — cursor should move up through visible
    // items and the viewport should remain stable (no re-scroll).
    const { lastFrame, stdin } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B", "C", "D", "E", "F", "G"]}
        initialIndex={7}
        onSelect={noop}
      />,
    );

    // Press UP to move cursor to F
    stdin.write("\x1b[A"); // UP arrow
    await vi.waitFor(() => {
      expect(lastFrame()!).toContain("> F");
    });

    // Press UP again — cursor moves to E; the visible window must NOT change
    // (items above and below the cursor should stay the same)
    stdin.write("\x1b[A");
    await vi.waitFor(() => {
      const frame = lastFrame()!;
      expect(frame).toContain("> E");
      // F should still be visible (cursor moved within window, no scroll)
      expect(frame).toContain("  F");
    });

    // Press UP again — cursor to D, window still stable
    stdin.write("\x1b[A");
    await vi.waitFor(() => {
      const frame = lastFrame()!;
      expect(frame).toContain("> D");
      expect(frame).toContain("  E");
      expect(frame).toContain("  F");
    });
  });

  it("shows dimmed scroll arrows when all choices fit", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    // Arrows are always present (dimmed when inactive)
    expect(frame).toContain("▲");
    expect(frame).toContain("▼");
  });

  it("shows select help text and does not advertise ESC dismiss", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("↵ select");
    expect(frame).not.toContain("ESC dismiss");
  });

  it("always shows Enter your own row", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    expect(lastFrame()!).toContain("Enter your own...");
  });

  it("shows Enter your own at the top of the list", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const lines = lastFrame()!.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const customRow = lines.findIndex((l) => l.includes("Enter your own"));
    const attackRow = lines.findIndex((l) => l.includes("Attack"));
    const fleeRow = lines.findIndex((l) => l.includes("Flee"));
    expect(customRow).toBeGreaterThanOrEqual(0);
    expect(customRow).toBeLessThan(attackRow);
    expect(attackRow).toBeLessThan(fleeRow);
  });

  it("shows submit/back help text when custom input is active", () => {
    // initialIndex = 0 activates custom input mode (custom is at the top now)
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack"]}
        initialIndex={0}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("submit");
    expect(frame).toContain("ESC back");
  });

  it("renders formatted choice labels without raw tags", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick a mood"
        choices={[
          "<color=#cc4444>Dread and Horror</color> — Slow burn",
          "<b>Grim Survival</b> — Desperate",
        ]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    // Formatted text is present
    expect(frame).toContain("Dread and Horror");
    expect(frame).toContain("Grim Survival");
    // Raw tags are not
    expect(frame).not.toContain("<color=");
    expect(frame).not.toContain("</color>");
    expect(frame).not.toContain("<b>");
    expect(frame).not.toContain("</b>");
  });

  it("renders within 7 rows", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick"
        choices={["A", "B", "C"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const lines = lastFrame()!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
  });

  it("renders formatted descriptions without raw tags", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Choose a path"
        choices={["Forest", "Cave"]}
        descriptions={[
          "A <b>dark</b> and <color=#22aa44>mossy</color> trail",
          "Echoing <i>whispers</i> from within",
        ]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    // Formatted text content is present
    expect(frame).toContain("dark");
    expect(frame).toContain("mossy");
    // Raw tags are stripped
    expect(frame).not.toContain("<b>");
    expect(frame).not.toContain("</b>");
    expect(frame).not.toContain("<color=");
    expect(frame).not.toContain("</color>");
    expect(frame).not.toContain("<i>");
  });

  it("wraps long choice labels across multiple lines", () => {
    const longChoice = "◆ Venture deep into the ancient forest where the twisted oaks whisper forgotten secrets to those brave enough to listen";
    const { lastFrame } = render(
      <ChoiceOverlay
        width={40}
        prompt="What next?"
        choices={[longChoice, "◆ Rest"]}
        initialIndex={1}
        maxChoiceRows={10}
        onSelect={noop}
      />,
    );
    const frame = lastFrame()!;
    // The long choice should be visible (wrapped, not truncated)
    expect(frame).toContain("Venture deep");
    expect(frame).toContain("Rest");
    // First line gets "> " prefix, continuation lines get "  "
    expect(frame).toContain("> ");
  });

  it("renders within 7 rows even with wrapped choices", () => {
    const longChoice = "◆ This is a very long choice label that will definitely need to wrap at a narrow width";
    const { lastFrame } = render(
      <ChoiceOverlay
        width={30}
        prompt="Pick"
        choices={[longChoice, "◆ Short"]}
        initialIndex={1}
        onSelect={noop}
      />,
    );
    const lines = lastFrame()!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
  });
});

// Sample groups mirroring the in-game ESC menu shape — built fresh per test
// so each test can mutate without leaking state. Engine Console is omitted
// here (the in-game version only shows it when dev mode is enabled).
function sampleGroups(): MenuGroup[] {
  return [
    { title: "View", items: [
      { key: "character_sheet", label: "Character Sheet", action: noop },
      { key: "compendium", label: "Compendium", action: noop },
      { key: "player_notes", label: "Player Notes", action: noop },
    ] },
    { title: "Session", items: [
      { key: "save_transcript", label: "Save Transcript", action: noop },
    ] },
    { title: "Settings", items: [
      { key: "campaign_settings", label: "Campaign Settings", action: noop },
    ] },
    { title: "Exit", items: [
      { key: "resume", label: "Resume", action: noop },
      { key: "return_to_menu", label: "Return to Menu", action: noop },
    ] },
  ];
}

describe("GameMenu", () => {
  it("renders every item across every group", () => {
    const groups = sampleGroups();
    const { lastFrame } = render(
      <Box width={60} height={30}>
        <GameMenu theme={theme} width={60} height={30} groups={groups} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame();
    for (const group of groups) {
      expect(frame).toContain(group.title);
      for (const item of group.items) {
        expect(frame).toContain(item.label);
      }
    }
  });

  it("does not render End Session (removed) or OOC Mode (removed)", () => {
    const { lastFrame } = render(
      <Box width={60} height={30}>
        <GameMenu theme={theme} width={60} height={30} groups={sampleGroups()} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).not.toContain("End Session");
    expect(frame).not.toContain("OOC Mode");
  });

  it("renders token summary in footer", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <GameMenu
          theme={theme}
          width={60}
          height={24}
          tokenSummary="0/0/0 | 2k/0/15k | 5k/200/40k"
          groups={sampleGroups()}
          onDismiss={noop}
        />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("0/0/0 | 2k/0/15k | 5k/200/40k");
  });

  it("appends remaining-usage percentage to footer when a primary percentage segment is present", () => {
    const usageStatus = {
      segments: [{
        id: "primary",
        label: "5-hour window",
        kind: "percentage" as const,
        usedPercent: 42,
        status: "warning" as const,
      }],
      snapshotAt: 1,
      fresh: true,
    };
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <GameMenu
          theme={theme}
          width={60}
          height={24}
          tokenSummary="0/0/0 | 2k/0/15k | 5k/200/40k"
          usageStatus={usageStatus}
          groups={sampleGroups()}
          onDismiss={noop}
        />
      </Box>,
    );
    // 42% used → 58% remaining, matching the gauge semantics.
    expect(lastFrame()).toContain("0/0/0 | 2k/0/15k | 5k/200/40k | 58%");
  });

  it("omits usage percentage when there is no primary segment", () => {
    const usageStatus = {
      segments: [{
        id: "credits",
        label: "Credit balance",
        kind: "balance" as const,
        used: 0,
        total: 100,
        status: "ok" as const,
      }],
      snapshotAt: 1,
      fresh: true,
    };
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <GameMenu
          theme={theme}
          width={60}
          height={24}
          tokenSummary="0/0/0"
          usageStatus={usageStatus}
          groups={sampleGroups()}
          onDismiss={noop}
        />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("0/0/0");
    expect(frame).not.toMatch(/0\/0\/0\s*\|/);
  });

  it("expands modal width to keep a long footer visible", () => {
    // Real-session token summary (multi-tier with cumulative totals) plus
    // the appended usage percentage easily exceeds the default 48-col
    // minWidth on an 80-col terminal. composeBottomFrame silently drops
    // the entire bottom border (corners and footer alike) when the
    // centerText doesn't fit, so the modal must self-expand.
    const usageStatus = {
      segments: [{
        id: "primary",
        label: "5-hour window",
        kind: "percentage" as const,
        usedPercent: 5,
        status: "ok" as const,
      }],
      snapshotAt: 1,
      fresh: true,
    };
    const longSummary = "200k/30k/300k | 100k/10k/180k | 25k/220/240k";
    const { lastFrame } = render(
      <Box width={80} height={25}>
        <GameMenu
          theme={theme}
          width={80}
          height={25}
          tokenSummary={longSummary}
          usageStatus={usageStatus}
          groups={sampleGroups()}
          onDismiss={noop}
        />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain(`${longSummary} | 95%`);
  });

  it("places cursor on the first selectable item (top of the first group)", () => {
    const { lastFrame } = render(
      <Box width={60} height={30}>
        <GameMenu theme={theme} width={60} height={30} groups={sampleGroups()} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame();
    // View is the first group; Character Sheet is its first item.
    expect(frame).toContain("◆ Character Sheet");
    expect(frame).toContain("○ Resume");
  });

  it("renders group header rows above each group's items", () => {
    const { lastFrame } = render(
      <Box width={60} height={30}>
        <GameMenu theme={theme} width={60} height={30} groups={sampleGroups()} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    // Headers render with surrounding dashes; matching the title in a "── X ─+"
    // shape confirms it's a group rule, not just an item label coincidence.
    expect(frame).toMatch(/── View ─+/);
    expect(frame).toMatch(/── Session ─+/);
    expect(frame).toMatch(/── Settings ─+/);
    expect(frame).toMatch(/── Exit ─+/);
  });
});

describe("CharacterSheetModal", () => {
  it("extracts title from H1 and renders styled body", () => {
    const content = [
      "# Aldric the Bold",
      "**Type:** PC",
      "**HP:** 42/42",
      "",
      "A stalwart warrior.",
    ].join("\n");

    const { lastFrame } = render(
      <Box width={50} height={24}>
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} onDismiss={() => {}} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric the Bold");
    expect(frame).toContain("Type:");
    expect(frame).toContain("PC");
    expect(frame).toContain("A stalwart warrior.");
  });

  it("renders list items with visual bullets", () => {
    const content = [
      "# Inventory",
      "- Sword of Light",
      "- Shield of Dawn",
    ].join("\n");

    const { lastFrame } = render(
      <Box width={50} height={24}>
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} onDismiss={() => {}} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("·");
    expect(frame).toContain("Sword of Light");
  });

  it("renders hex color strings in their own color", () => {
    const content = [
      "# Aldric the Bold",
      "**Color:** #cc0000",
      "**Type:** PC",
    ].join("\n");

    const { lastFrame } = render(
      <Box width={50} height={24}>
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} onDismiss={() => {}} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("#cc0000");
  });

  it("uses default title when no H1 present", () => {
    const { lastFrame } = render(
      <Box width={50} height={24}>
        <CharacterSheetModal
          theme={theme}
          width={50}
          height={24}
          content="Just some text"
          onDismiss={() => {}}
        />
      </Box>,
    );
    expect(lastFrame()).toContain("Character Sheet");
  });
});

describe("SessionRecapModal", () => {
  it("renders recap with header and continue prompt", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SessionRecapModal
          theme={theme}
          width={100}
          height={30}
          onDismiss={() => {}}
          lines={[
            "The party entered the hall.",
            "Aldric confronted the king.",
          ]}
        />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Previously on...");
    expect(frame).toContain("The party entered the hall.");
    expect(frame).toContain("ESC or Enter to continue");
  });

  it("word-wraps long lines to fit 40-char modal", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SessionRecapModal
          theme={theme}
          width={100}
          height={30}
          onDismiss={() => {}}
          lines={[
            "The adventurers ventured deep into the ancient catacombs beneath the city.",
          ]}
        />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("adventurers");
    expect(frame).toContain("catacombs");
  });
});

describe("SwatchModal", () => {
  it("renders the theme title in the frame", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain(theme.asset.name);
    expect(frame).toContain("exploration");
  });

  it("renders anchor row labels", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} onDismiss={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("0:");
    expect(frame).toContain("100:");
  });

  it("renders the dismiss footer", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} onDismiss={noop} />
      </Box>,
    );
    expect(lastFrame()).toContain("Press any key to dismiss");
  });

  it("renders colorMap assignment text", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} onDismiss={noop} />
      </Box>,
    );
    expect(lastFrame()).toContain("border:");
  });
});

describe("RollbackPickerModal", () => {
  const savepoints: Savepoint[] = [
    { oid: "aaaaaaa", type: "auto", message: "I draw my sword", timestamp: 1_700_000_400 },
    { oid: "bbbbbbb", type: "auto", message: "I open the door", timestamp: 1_700_000_200 },
    { oid: "ccccccc", type: "scene", message: "scene: The Caves", timestamp: 1_700_000_000 },
  ];

  it("lists savepoint messages and tags non-auto commits", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <RollbackPickerModal theme={theme} width={100} height={30} savepoints={savepoints} gitEnabled onSelect={noop} onCancel={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("I draw my sword");
    expect(frame).toContain("I open the door");
    expect(frame).toContain("[scene]");
  });

  it("Enter selects the cursored savepoint with its index after moving down", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <Box width={100} height={30}>
        <RollbackPickerModal theme={theme} width={100} height={30} savepoints={savepoints} gitEnabled onSelect={onSelect} onCancel={noop} />
      </Box>,
    );
    stdin.write("\x1b[B"); // DOWN → index 1
    // Wait for the cursor to land on index 1 before pressing Enter — otherwise
    // the Enter handler closes over the stale (pre-move) selectedIndex.
    await vi.waitFor(() => {
      expect(lastFrame()!).toContain("◆ I open the door");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(savepoints[1], 1);
    });
  });

  it("shows a disabled message when git is off", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <RollbackPickerModal theme={theme} width={100} height={30} savepoints={[]} gitEnabled={false} onSelect={noop} onCancel={noop} />
      </Box>,
    );
    expect(lastFrame()).toContain("git is disabled");
  });
});

describe("RollbackConfirmModal", () => {
  const savepoint: Savepoint = { oid: "aaaaaaa", type: "auto", message: "I open the door", timestamp: 1_700_000_000 };

  it("shows the target and discard count, and notes the backup", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <RollbackConfirmModal theme={theme} width={100} height={30} savepoint={savepoint} discardCount={3} onConfirm={noop} onCancel={noop} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("I open the door");
    expect(frame).toContain("Discards 3 later savepoints");
    expect(frame).toContain("Archived");
  });

  it("defaults to Cancel; Enter cancels", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <Box width={100} height={30}>
        <RollbackConfirmModal theme={theme} width={100} height={30} savepoint={savepoint} discardCount={1} onConfirm={onConfirm} onCancel={onCancel} />
      </Box>,
    );
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalledOnce();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("arrow to Roll Back then Enter confirms", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, lastFrame } = render(
      <Box width={100} height={30}>
        <RollbackConfirmModal theme={theme} width={100} height={30} savepoint={savepoint} discardCount={1} onConfirm={onConfirm} onCancel={onCancel} />
      </Box>,
    );
    stdin.write("\x1b[D"); // LEFT → toggles selection to Roll Back
    await vi.waitFor(() => {
      expect(lastFrame()!).toContain("[Roll Back]");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalledOnce();
    });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
