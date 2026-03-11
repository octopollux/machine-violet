import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Modal } from "./Modal.js";
import { ChoiceModal, ChoiceOverlay } from "./ChoiceModal.js";
import { GameMenu, getMenuItems } from "./GameMenu.js";
import { CharacterSheetModal } from "./CharacterSheetModal.js";
import { DiceRollModal } from "./DiceRollModal.js";
import { SessionRecapModal } from "./SessionRecapModal.js";
import { SwatchModal } from "./SwatchModal.js";
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

describe("ChoiceOverlay", () => {
  it("renders prompt and choices without frame borders", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee", "Negotiate"]}
        selectedIndex={0}
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

  it("shows scroll arrows", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B"]}
        selectedIndex={0}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("▲");
    expect(frame).toContain("▼");
  });

  it("shows ESC dismiss help text", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick one"
        choices={["A", "B"]}
        selectedIndex={0}
      />,
    );
    expect(lastFrame()!).toContain("ESC dismiss");
  });

  it("shows custom input row when showCustomInput is true", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack", "Flee"]}
        selectedIndex={0}
        showCustomInput
      />,
    );
    expect(lastFrame()!).toContain("Enter your own...");
  });

  it("shows submit/back help text when custom input is active", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="What do you do?"
        choices={["Attack"]}
        selectedIndex={1}
        showCustomInput
        customInputActive
        customInputResetKey={0}
        onCustomInputSubmit={() => {}}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("submit");
    expect(frame).toContain("ESC back");
  });

  it("renders within 7 rows", () => {
    const { lastFrame } = render(
      <ChoiceOverlay
        width={60}
        prompt="Pick"
        choices={["A", "B", "C"]}
        selectedIndex={0}
        showCustomInput
      />,
    );
    const lines = lastFrame()!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
  });
});

describe("GameMenu", () => {
  it("renders all menu items", () => {
    const { lastFrame } = render(
      <Box width={40} height={24}>
        <GameMenu theme={theme} width={40} height={24} selectedIndex={0} />
      </Box>,
    );
    const frame = lastFrame();
    for (const item of getMenuItems()) {
      expect(frame).toContain(item);
    }
  });

  it("renders token summary in footer", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <GameMenu
          theme={theme}
          width={60}
          height={24}
          selectedIndex={0}
          tokenSummary="0/0/0 | 2k/0/15k | 5k/200/40k"
        />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("0/0/0 | 2k/0/15k | 5k/200/40k");
  });

  it("highlights selected item", () => {
    const { lastFrame } = render(
      <Box width={40} height={24}>
        <GameMenu theme={theme} width={40} height={24} selectedIndex={2} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("◆ OOC Mode");
    expect(frame).toContain("○ Resume");
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
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} />
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
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} />
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
        <CharacterSheetModal theme={theme} width={50} height={24} content={content} />
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
        />
      </Box>,
    );
    expect(lastFrame()).toContain("Character Sheet");
  });
});

describe("DiceRollModal", () => {
  it("renders expression and total", () => {
    const { lastFrame } = render(
      <DiceRollModal
        theme={theme}
        width={50}
        expression="2d6+3"
        rolls={[4, 5]}
        total={12}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Rolling: 2d6+3");
    expect(frame).toContain("4  5");
    expect(frame).toContain("Total: 12");
  });

  it("shows kept dice when different from rolls", () => {
    const { lastFrame } = render(
      <DiceRollModal
        theme={theme}
        width={50}
        expression="4d6kh3"
        rolls={[3, 5, 1, 6]}
        kept={[3, 5, 6]}
        total={14}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Dice: [ 3  5  1  6 ]");
    expect(frame).toContain("Kept: [ 3  5  6 ]");
  });

  it("shows reason when provided", () => {
    const { lastFrame } = render(
      <DiceRollModal
        theme={theme}
        width={50}
        expression="1d20+5"
        rolls={[17]}
        total={22}
        reason="Attack roll vs. Goblin"
      />,
    );
    expect(lastFrame()).toContain("Attack roll vs. Goblin");
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
        <SwatchModal theme={theme} width={100} height={30} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain(theme.asset.name);
    expect(frame).toContain("exploration");
  });

  it("renders anchor row labels", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} />
      </Box>,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("0:");
    expect(frame).toContain("100:");
  });

  it("renders the dismiss footer", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} />
      </Box>,
    );
    expect(lastFrame()).toContain("Press any key to dismiss");
  });

  it("renders colorMap assignment text", () => {
    const { lastFrame } = render(
      <Box width={100} height={30}>
        <SwatchModal theme={theme} width={100} height={30} />
      </Box>,
    );
    expect(lastFrame()).toContain("border:");
  });
});
