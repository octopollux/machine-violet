import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Modeline, buildModelineDisplay, splitModeline, modelineVisibleLength } from "./Modeline.js";
import { InputLine } from "./InputLine.js";
import { PlayerSelector } from "./PlayerSelector.js";
import { ActivityLine } from "./ActivityLine.js";
import { NarrativeArea } from "./NarrativeArea.js";
import { HorizontalBorder, SideFrame } from "./FrameBorder.js";
import { getStyle } from "../frames/index.js";

const gothic = getStyle("gothic")!.variants.exploration;

describe("buildModelineDisplay", () => {
  it("returns text when no extras", () => {
    expect(buildModelineDisplay("HP: 42/42")).toBe("HP: 42/42");
  });

  it("prefixes activity glyph", () => {
    expect(buildModelineDisplay("HP: 42/42", "⚔")).toBe("⚔ HP: 42/42");
  });

  it("prefixes turn info", () => {
    expect(buildModelineDisplay("HP: 42/42", undefined, "Aldric")).toBe("[Aldric] HP: 42/42");
  });

  it("prefixes both glyph and turn info", () => {
    expect(buildModelineDisplay("HP: 42/42", "⚔", "Aldric")).toBe("⚔ [Aldric] HP: 42/42");
  });
});

describe("splitModeline", () => {
  it("returns single line when text fits", () => {
    expect(splitModeline("HP: 42/42 | Loc: Hall", 80)).toEqual(["HP: 42/42 | Loc: Hall"]);
  });

  it("splits at pipe when text exceeds width", () => {
    const text = "HP: 42/42 | Mana: 7/12 | Loc: The Hall";
    const lines = splitModeline(text, 30);
    expect(lines.length).toBeGreaterThan(1);
    // Each line should fit within width
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
    // No line should contain a leading or trailing " | " from the split
    for (const line of lines) {
      expect(line).not.toMatch(/^ \| /);
      expect(line).not.toMatch(/ \| $/);
    }
  });

  it("greedily packs segments", () => {
    // "A | B" is 5 chars, fits in 8; adding " | C" makes 10 → wraps
    expect(splitModeline("A | B | C", 8)).toEqual(["A | B", "C"]);
  });

  it("returns one line when no pipes present", () => {
    expect(splitModeline("A very long modeline with no pipes", 10)).toEqual(
      ["A very long modeline with no pipes"],
    );
  });

  it("handles empty string", () => {
    expect(splitModeline("", 80)).toEqual([""]);
  });

  it("each segment too wide gets own line", () => {
    expect(splitModeline("AAAA | BBBB | CCCC", 4)).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("measures visible length excluding formatting tags", () => {
    // "<b>A</b> | B" has visible length 5 ("A | B"), fits in width 8
    // Adding " | C" makes visible "A | B | C" = 9 → wraps
    expect(splitModeline("<b>A</b> | B | C", 8)).toEqual(["<b>A</b> | B", "C"]);
  });
});

describe("modelineVisibleLength", () => {
  it("returns plain text length for unformatted string", () => {
    expect(modelineVisibleLength("HP: 42/42")).toBe(9);
  });

  it("excludes formatting tags from length", () => {
    expect(modelineVisibleLength("<b>HP:</b> 42/42")).toBe(9);
    expect(modelineVisibleLength("<color=#ff0000>HP:</color> 42/42")).toBe(9);
  });
});

describe("Modeline", () => {
  it("renders single line", () => {
    const { lastFrame } = render(<Modeline lines={["HP: 42/42 | Loc: Hall"]} />);
    expect(lastFrame()).toContain("HP: 42/42");
    expect(lastFrame()).toContain("Loc: Hall");
  });

  it("renders multiple lines", () => {
    const { lastFrame } = render(
      <Modeline lines={["HP: 42/42 | Mana: 7/12", "Loc: The Shattered Hall"]} />,
    );
    expect(lastFrame()).toContain("HP: 42/42");
    expect(lastFrame()).toContain("Loc: The Shattered Hall");
  });

  it("renders inline formatting tags", () => {
    const { lastFrame } = render(
      <Modeline lines={["<b>HP:</b> 42/42 | <color=#ff0000>Poisoned</color>"]} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("HP:");
    expect(frame).toContain("42/42");
    expect(frame).toContain("Poisoned");
    // Tags should not appear as literal text
    expect(frame).not.toContain("<b>");
    expect(frame).not.toContain("<color=");
  });
});

describe("InputLine", () => {
  it("renders character name and prompt", () => {
    const { lastFrame } = render(
      <InputLine characterName="Aldric" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Aldric");
    expect(frame).toContain(">");
  });

  it("shows player name when playerSelector dropped", () => {
    const { lastFrame } = render(
      <InputLine
        characterName="Aldric"
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
    const frame = lastFrame()!;
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

  it("renders accumulated tool glyphs after label", () => {
    const glyphs = [
      { glyph: "⚄", color: "yellow" },
      { glyph: "⚔", color: "red" },
    ];
    const { lastFrame } = render(
      <ActivityLine engineState="dm_thinking" toolGlyphs={glyphs} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("DM is thinking");
    expect(frame).toContain("⚄");
    expect(frame).toContain("⚔");
  });

  it("renders no glyphs when array is empty", () => {
    const { lastFrame } = render(
      <ActivityLine engineState="dm_thinking" toolGlyphs={[]} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("DM is thinking");
    // No trailing space from empty glyph list
    expect(frame).not.toContain("⚄");
  });

  it("renders duplicate glyphs for repeated tool calls", () => {
    const glyphs = [
      { glyph: "⚄", color: "yellow" },
      { glyph: "⚄", color: "yellow" },
      { glyph: "◈", color: "blue" },
    ];
    const { lastFrame } = render(
      <ActivityLine engineState="dm_thinking" toolGlyphs={glyphs} />,
    );
    const frame = lastFrame();
    // Both dice glyphs should appear (not deduplicated)
    const diceCount = (frame.match(/⚄/g) || []).length;
    expect(diceCount).toBe(2);
    expect(frame).toContain("◈");
  });
});

describe("NarrativeArea", () => {
  const dm = (text: string) => ({ kind: "dm" as const, text });
  const player = (text: string) => ({ kind: "player" as const, text });

  it("renders text lines", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("The door creaks open."), dm("A cold wind blows.")]}
        maxRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("The door creaks open.");
    expect(frame).toContain("A cold wind blows.");
  });

  it("renders with many lines without crashing", () => {
    const lines = Array.from({ length: 200 }, (_, i) => dm(`Line ${i + 1}`));
    const { lastFrame } = render(
      <NarrativeArea lines={lines} maxRows={10} />,
    );
    const frame = lastFrame()!;
    // ScrollView manages viewport — renders without error
    expect(frame.length).toBeGreaterThan(0);
    // Content is present (viewport shows some subset)
    expect(frame).toContain("Line");
  });

  it("renders DM formatting tags", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("The <b>King</b> has fallen.")]}
        maxRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("King");
    expect(frame).toContain("has fallen");
    // Bold styling is applied via ANSI codes (tested by presence of content)
  });

  it("renders centered text when width is provided", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("<center>Chapter 1</center>")]}
        maxRows={5}
        width={40}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Chapter 1");
  });

  it("renders right-aligned text when width is provided", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("<right>Page 42</right>")]}
        maxRows={5}
        width={40}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Page 42");
  });

  it("renders center tag as plain text without width", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("<center>No width</center>")]}
        maxRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("No width");
  });

  it("renders player input lines with colored carat and text", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[player("> Aldric: I attack the goblin!")]}
        maxRows={5}
        playerColor="#5a9cff"
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain(">");
    expect(frame).toContain("Aldric: I attack the goblin!");
  });

  it("renders player input as plain text without playerColor", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[player("> Aldric: I attack the goblin!")]}
        maxRows={5}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> Aldric: I attack the goblin!");
  });

  it("renders blank lines as visible empty lines", () => {
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("Line A"), dm(""), dm("Line B")]}
        maxRows={10}
      />,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    // Find the indices of content lines
    const lineA = lines.findIndex((l) => l.includes("Line A"));
    const lineB = lines.findIndex((l) => l.includes("Line B"));
    // There should be a gap (blank line) between them
    expect(lineB - lineA).toBeGreaterThanOrEqual(2);
  });

  it("renders turn separator between DM and player lines", () => {
    // Separators are now inserted by engine callbacks, not by the formatting pipeline.
    // NarrativeArea just renders pre-separated lines.
    const { lastFrame } = render(
      <NarrativeArea
        lines={[dm("DM speaks."), { kind: "separator", text: "" }, player("> I respond.")]}
        maxRows={10}
      />,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    const dmLine = lines.findIndex((l) => l.includes("DM speaks."));
    const playerLine = lines.findIndex((l) => l.includes("I respond."));
    // Turn separator should create a gap
    expect(playerLine - dmLine).toBeGreaterThanOrEqual(2);
  });
});

describe("SideFrame", () => {
  it("renders vertical chars for given height", () => {
    const { lastFrame } = render(
      <SideFrame variant={gothic} side="left" height={3} />,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain("║");
    }
  });

  it("renders right side identically at width 1", () => {
    const { lastFrame } = render(
      <SideFrame variant={gothic} side="right" height={2} />,
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("║");
    }
  });

  it("renders width 2 with padding", () => {
    const { lastFrame } = render(
      <SideFrame variant={gothic} side="left" height={2} frameWidth={2} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("║");
  });

  it("renders ASCII fallback", () => {
    const { lastFrame } = render(
      <SideFrame variant={gothic} side="left" height={2} ascii />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("|");
  });
});

describe("FrameBorder components", () => {
  it("renders horizontal border", () => {
    const { lastFrame } = render(
      <HorizontalBorder variant={gothic} width={40} position="top" />,
    );
    const frame = lastFrame()!;
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

});
