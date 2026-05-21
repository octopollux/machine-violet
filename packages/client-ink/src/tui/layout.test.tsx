import React from "react";
import { Text } from "ink";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Layout } from "./layout.js";
import { resolveTheme, resetThemeCache, BUILTIN_DEFINITIONS } from "./themes/index.js";

beforeEach(() => {
  resetThemeCache();
});

const theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#888888");

const baseProps = {
  dimensions: { columns: 80, rows: 40 },
  theme,
  narrativeLines: [
    { kind: "dm" as const, text: "The door groans open onto a long hall." },
    { kind: "dm" as const, text: "A figure sits motionless in a high-backed chair." },
  ],
  modelineText: "HP: 42/42 | Loc: The Shattered Hall",
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

  it("shows activity glyph in modeline at standard viewport", () => {
    const { lastFrame } = render(
      <Layout
        {...baseProps}
        dimensions={{ columns: 80, rows: 30 }}
        engineState="dm_thinking"
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("◆");
  });

  it("renders with combat theme variant", () => {
    const combatTheme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "combat", "#888888");
    const { lastFrame } = render(
      <Layout {...baseProps} theme={combatTheme} />,
    );
    const frame = lastFrame();
    expect(frame).toContain("Aldric's Turn");
  });

  it("playerPaneOverlay shows modeline alongside overlay at full tier", () => {
    const overlay = <Text>OVERLAY CONTENT</Text>;
    const { lastFrame } = render(
      <Layout {...baseProps} playerPaneOverlay={overlay} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("OVERLAY CONTENT");
    // At full tier (80x40), modeline is visible alongside the overlay
    expect(frame).toContain("Loc: The Shattered Hall");
  });

  it("wraps an overflowing title onto a continuation row inside the top frame", () => {
    // Real campaign repro: "Warranty Void" with four resources blows past
    // the title slot and used to vanish the entire top edge. The fix
    // splits the title at ` | ` and renders the spillover on row 1 of the
    // top frame (gothic's previously-blank second row), so no blank row
    // appears between the head and the continuation.
    const { lastFrame } = render(
      <Layout
        {...baseProps}
        campaignName="Warranty Void"
        resources={[
          "Processing Cycles 1/10",
          "Coherence 4/10",
          "Connections 3/5",
          "Memory Integrity 6/10",
        ]}
      />,
    );
    const frame = lastFrame()!;
    // Top edge corners survive — without wrapping, composeTopFrame would
    // drop them along with the title.
    expect(frame).toContain("╔");
    expect(frame).toContain("╗");
    // Both halves of the wrapped title render somewhere on screen.
    expect(frame).toContain("Warranty Void");
    expect(frame).toContain("Memory Integrity 6/10");
    // The continuation sits on the very next line below the head row —
    // no blank intervening row in the frame. (Splitting on \n and reading
    // adjacent rows is the most direct check.)
    const lines = frame.split("\n");
    const headIdx = lines.findIndex((l) => l.includes("Warranty Void"));
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(lines[headIdx + 1]).toContain("Memory Integrity 6/10");
  });

  it("playerPaneOverlay replaces modeline at standard tier", () => {
    const overlay = <Text>OVERLAY CONTENT</Text>;
    const { lastFrame } = render(
      <Layout {...baseProps} dimensions={{ columns: 80, rows: 30 }} playerPaneOverlay={overlay} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("OVERLAY CONTENT");
    // At standard tier, modeline is hidden — overlay fills the pane
    expect(frame).not.toContain("Loc: The Shattered Hall");
  });
});
