import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { extractSections, CharacterPane } from "./CharacterPane.js";
import { OverlayPane } from "./OverlayPane.js";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import { BUILTIN_DEFINITIONS } from "../themes/builtin-definitions.js";

let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

// ---------------------------------------------------------------------------
// extractSections — pure logic
// ---------------------------------------------------------------------------

describe("extractSections", () => {
  const sheet = [
    "# Oros",
    "**Type:** PC",
    "**HP:** 10/10",
    "",
    "## Stats",
    "STR 14 / DEX 12 / CON 10",
    "WIS 16 / INT 8 / CHA 11",
    "",
    "## Resources",
    "Memory: Intact",
    "",
    "## Inventory",
    "- [[Brass Brooch]]",
    "- 3 silver coins",
    "",
    "## Changelog",
    "- **Scene 001**: Created.",
  ].join("\n");

  it("extracts Stats and Inventory sections", () => {
    const result = extractSections(sheet, ["Stats", "Inventory"]);
    expect(result).toContain("## Stats");
    expect(result).toContain("STR 14 / DEX 12 / CON 10");
    expect(result).toContain("## Inventory");
    expect(result).toContain("- [[Brass Brooch]]");
  });

  it("excludes sections not requested", () => {
    const result = extractSections(sheet, ["Stats", "Inventory"]);
    const joined = result.join("\n");
    expect(joined).not.toContain("Resources");
    expect(joined).not.toContain("Changelog");
    expect(joined).not.toContain("Memory: Intact");
  });

  it("is case-insensitive for heading names", () => {
    const result = extractSections(sheet, ["stats", "INVENTORY"]);
    expect(result).toContain("## Stats");
    expect(result).toContain("## Inventory");
  });

  it("returns empty array when no matching sections found", () => {
    const result = extractSections(sheet, ["Spells", "Feats"]);
    expect(result).toEqual([]);
  });

  it("inserts blank line between consecutive sections", () => {
    const result = extractSections(sheet, ["Stats", "Inventory"]);
    // Find the blank line separator between sections
    const statsEnd = result.indexOf("## Inventory");
    expect(statsEnd).toBeGreaterThan(0);
    expect(result[statsEnd - 1]).toBe("");
  });

  it("handles sheet with only one matching section", () => {
    const result = extractSections(sheet, ["Inventory"]);
    expect(result[0]).toBe("## Inventory");
    expect(result).toContain("- [[Brass Brooch]]");
    const joined = result.join("\n");
    expect(joined).not.toContain("Stats");
  });
});

// ---------------------------------------------------------------------------
// OverlayPane — rendering
// ---------------------------------------------------------------------------

describe("OverlayPane", () => {
  it("renders title in top border", () => {
    const { lastFrame } = render(
      <Box width={80} height={30}>
        <OverlayPane
          theme={theme}
          narrativeWidth={80}
          narrativeHeight={30}
          paneWidth={25}
          title="Oros"
          lines={["STR 14", "DEX 12"]}
        />
      </Box>,
    );
    expect(lastFrame()).toContain("Oros");
  });

  it("renders content lines", () => {
    // Wrap in a sized Box so absolute positioning has a container
    const { lastFrame } = render(
      <Box width={80} height={30}>
        <OverlayPane
          theme={theme}
          narrativeWidth={80}
          narrativeHeight={30}
          paneWidth={25}
          lines={["STR 14", "DEX 12"]}
        />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("STR 14");
    expect(frame).toContain("DEX 12");
  });

  it("clamps paneWidth to narrativeWidth", () => {
    // paneWidth larger than narrativeWidth — should not exceed
    const { lastFrame } = render(
      <Box width={20} height={30}>
        <OverlayPane
          theme={theme}
          narrativeWidth={20}
          narrativeHeight={30}
          paneWidth={25}
          lines={["test"]}
        />
      </Box>,
    );
    // Should still render without crashing
    expect(lastFrame()).toContain("test");
  });
});
