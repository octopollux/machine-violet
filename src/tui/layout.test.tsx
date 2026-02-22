import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Layout } from "./layout.js";
import { getStyle } from "./frames/index.js";

const style = getStyle("gothic")!;

const baseProps = {
  dimensions: { columns: 80, rows: 40 },
  style,
  variant: "exploration" as const,
  narrativeLines: [
    { kind: "dm" as const, text: "The door groans open onto a long hall." },
    { kind: "dm" as const, text: "A figure sits motionless in a high-backed chair." },
  ],
  modelineText: "HP: 42/42 | Loc: The Shattered Hall",
  inputValue: "",
  activeCharacterName: "Aldric",
  players: [
    { name: "Aldric", isAI: false },
    { name: "Sable", isAI: false },
    { name: "Rook", isAI: true },
  ],
  activePlayerIndex: 0,
  campaignName: "The Shattered Crown",
  resources: ["HP: 42/42", "Mana: 7/12"],
  turnHolder: "Aldric",
  engineState: null,
};

describe("Layout", () => {
  it("renders full layout at 80x40", () => {
    const { lastFrame } = render(<Layout {...baseProps} />);
    const frame = lastFrame();
    expect(frame).toContain("The door groans open");
    expect(frame).toContain("HP: 42/42");
    expect(frame).toContain("Aldric");
    expect(frame).toContain("Sable");
    expect(frame).toContain("Rook(AI)");
    expect(frame).toContain("Aldric's Turn");
  });

  it("renders top frame with resources", () => {
    const { lastFrame } = render(<Layout {...baseProps} />);
    const frame = lastFrame();
    expect(frame).toContain("The Shattered Crown");
  });

  it("drops elements at narrow viewport", () => {
    const { lastFrame } = render(
      <Layout {...baseProps} dimensions={{ columns: 60, rows: 40 }} />,
    );
    const frame = lastFrame();
    // Still shows narrative and player selector
    expect(frame).toContain("The door groans open");
    expect(frame).toContain("Aldric");
  });

  it("shows activity glyph in modeline at compact viewport", () => {
    const { lastFrame } = render(
      <Layout
        {...baseProps}
        dimensions={{ columns: 60, rows: 30 }}
        engineState="dm_thinking"
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("◆");
  });

  it("renders minimal layout", () => {
    const { lastFrame } = render(
      <Layout {...baseProps} dimensions={{ columns: 30, rows: 12 }} />,
    );
    const frame = lastFrame();
    // Just narrative + input
    expect(frame).toContain("Aldric");
    expect(frame).toContain(">");
  });

  it("renders with combat variant", () => {
    const { lastFrame } = render(
      <Layout {...baseProps} variant="combat" />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric's Turn");
  });
});
