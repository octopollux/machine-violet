import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Modeline } from "./Modeline.js";
import { InputLine } from "./InputLine.js";
import { PlayerSelector } from "./PlayerSelector.js";
import { ActivityLine } from "./ActivityLine.js";
import { NarrativeArea } from "./NarrativeArea.js";
import { HorizontalBorder, FramedContent } from "./FrameBorder.js";
import { getStyle } from "../frames/index.js";

const gothic = getStyle("gothic")!.variants.exploration;

describe("Modeline", () => {
  it("renders text", () => {
    const { lastFrame } = render(<Modeline text="HP: 42/42 | Loc: Hall" />);
    expect(lastFrame()).toContain("HP: 42/42");
    expect(lastFrame()).toContain("Loc: Hall");
  });

  it("prefixes activity glyph", () => {
    const { lastFrame } = render(
      <Modeline text="HP: 42/42" activityGlyph="⚔" />,
    );
    expect(lastFrame()).toContain("⚔");
  });

  it("prefixes turn info", () => {
    const { lastFrame } = render(
      <Modeline text="HP: 42/42" turnInfo="Aldric" />,
    );
    expect(lastFrame()).toContain("[Aldric]");
  });
});

describe("InputLine", () => {
  it("renders character name and cursor", () => {
    const { lastFrame } = render(
      <InputLine characterName="Aldric" value="I swing my sword" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric");
    expect(frame).toContain(">");
    expect(frame).toContain("I swing my sword");
  });

  it("shows player name when playerSelector dropped", () => {
    const { lastFrame } = render(
      <InputLine
        characterName="Aldric"
        value=""
        showPlayerName
        playerName="Alex"
      />,
    );
    expect(lastFrame()).toContain("Alex/Aldric");
  });
});

describe("PlayerSelector", () => {
  it("renders nothing for single player", () => {
    const { lastFrame } = render(
      <PlayerSelector
        players={[{ name: "Alex", isAI: false }]}
        activeIndex={0}
      />,
    );
    expect(lastFrame()).toBe("");
  });

  it("renders multiple players", () => {
    const { lastFrame } = render(
      <PlayerSelector
        players={[
          { name: "Aldric", isAI: false },
          { name: "Sable", isAI: false },
          { name: "Rook", isAI: true },
        ]}
        activeIndex={0}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric");
    expect(frame).toContain("Sable");
    expect(frame).toContain("Rook(AI)");
  });
});

describe("ActivityLine", () => {
  it("renders for known engine state", () => {
    const { lastFrame } = render(<ActivityLine engineState="dm_thinking" />);
    expect(lastFrame()).toContain("DM is thinking");
  });

  it("renders nothing when idle", () => {
    const { lastFrame } = render(<ActivityLine engineState={null} />);
    expect(lastFrame()).toBe("");
  });
});

describe("NarrativeArea", () => {
  it("renders text lines", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={["The door creaks open.", "A cold wind blows."]}
        maxRows={5}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("The door creaks open.");
    expect(frame).toContain("A cold wind blows.");
  });

  it("renders with many lines without crashing", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
    const { lastFrame } = render(
      <NarrativeArea lines={lines} maxRows={10} />,
    );
    const frame = lastFrame();
    // ScrollView manages viewport — renders without error
    expect(frame.length).toBeGreaterThan(0);
    // Content is present (viewport shows some subset)
    expect(frame).toContain("Line");
  });

  it("renders DM formatting tags", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={["The <b>King</b> has fallen."]}
        maxRows={5}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("King");
    expect(frame).toContain("has fallen");
    // Bold styling is applied via ANSI codes (tested by presence of content)
  });
});

describe("FrameBorder components", () => {
  it("renders horizontal border", () => {
    const { lastFrame } = render(
      <HorizontalBorder variant={gothic} width={40} position="top" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("╔");
    expect(frame).toContain("═");
  });

  it("renders border with centered text", () => {
    const { lastFrame } = render(
      <HorizontalBorder
        variant={gothic}
        width={40}
        position="bottom"
        centerText="Aldric's Turn"
      />,
    );
    expect(lastFrame()).toContain("Aldric's Turn");
  });

  it("renders framed content", () => {
    const { lastFrame } = render(
      <FramedContent variant={gothic} width={40} content="Hello" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("║");
    expect(frame).toContain("Hello");
  });
});
