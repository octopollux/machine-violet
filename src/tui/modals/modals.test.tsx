import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Modal } from "./Modal.js";
import { ChoiceModal } from "./ChoiceModal.js";
import { GameMenu, MENU_ITEMS } from "./GameMenu.js";
import { CharacterSheetModal } from "./CharacterSheetModal.js";
import { DiceRollModal } from "./DiceRollModal.js";
import { SessionRecapModal } from "./SessionRecapModal.js";
import { getStyle } from "../frames/index.js";

const gothic = getStyle("gothic")!.variants.exploration;

describe("Modal", () => {
  it("renders border and content", () => {
    const { lastFrame } = render(
      <Modal variant={gothic} width={40} children={["Hello world"]} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Hello world");
    expect(frame).toContain("╔");
    expect(frame).toContain("╚");
  });

  it("renders title in top border", () => {
    const { lastFrame } = render(
      <Modal variant={gothic} width={40} title="Test" children={["Body"]} />,
    );
    expect(lastFrame()).toContain("Test");
  });
});

describe("ChoiceModal", () => {
  it("renders prompt and labeled choices", () => {
    const { lastFrame } = render(
      <ChoiceModal
        variant={gothic}
        width={50}
        prompt="What do you do?"
        choices={["Attack", "Flee", "Negotiate"]}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("What do you do?");
    expect(frame).toContain("A) Attack");
    expect(frame).toContain("B) Flee");
    expect(frame).toContain("C) Negotiate");
  });
});

describe("GameMenu", () => {
  it("renders all menu items", () => {
    const { lastFrame } = render(
      <GameMenu variant={gothic} width={40} selectedIndex={0} />,
    );
    const frame = lastFrame();
    for (const item of MENU_ITEMS) {
      expect(frame).toContain(item);
    }
  });

  it("highlights selected item", () => {
    const { lastFrame } = render(
      <GameMenu variant={gothic} width={40} selectedIndex={2} />,
    );
    const frame = lastFrame();
    // Selected item gets ◆, others get ○
    expect(frame).toContain("◆ OOC Mode");
    expect(frame).toContain("○ Resume");
  });
});

describe("CharacterSheetModal", () => {
  it("extracts title from H1 and renders body", () => {
    const content = [
      "# Aldric the Bold",
      "**Type:** PC",
      "**HP:** 42/42",
      "",
      "A stalwart warrior.",
    ].join("\n");

    const { lastFrame } = render(
      <CharacterSheetModal variant={gothic} width={50} content={content} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric the Bold");
    expect(frame).toContain("**Type:** PC");
    expect(frame).toContain("A stalwart warrior.");
  });

  it("uses default title when no H1 present", () => {
    const { lastFrame } = render(
      <CharacterSheetModal
        variant={gothic}
        width={50}
        content="Just some text"
      />,
    );
    expect(lastFrame()).toContain("Character Sheet");
  });
});

describe("DiceRollModal", () => {
  it("renders expression and total", () => {
    const { lastFrame } = render(
      <DiceRollModal
        variant={gothic}
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
        variant={gothic}
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
        variant={gothic}
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
      <SessionRecapModal
        variant={gothic}
        width={60}
        lines={[
          "The party entered the Shattered Hall.",
          "Aldric confronted the shadow king.",
        ]}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Session Recap");
    expect(frame).toContain("Previously on...");
    expect(frame).toContain("The party entered the Shattered Hall.");
    expect(frame).toContain("Press any key to continue");
  });
});
