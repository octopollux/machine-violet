import { describe, it, expect, beforeEach } from "vitest";
import { buildUIState, buildActiveState } from "./dm-prompt.js";
import { resetPromptCache } from "../prompts/load-prompt.js";

beforeEach(() => {
  resetPromptCache();
});

describe("buildUIState", () => {
  it("builds UI state with modelines and style", () => {
    const result = buildUIState({
      modelines: { Aldric: "HP 45/50 | Blessed" },
      styleName: "gothic",
      variant: "exploration",
    });

    expect(result).toContain("Modelines (as last set by you):");
    expect(result).toContain("Aldric: HP 45/50 | Blessed");
    expect(result).toContain("UI: style=gothic, variant=exploration");
  });

  it("includes multiple characters", () => {
    const result = buildUIState({
      modelines: {
        Aldric: "HP 45/50 | Blessed",
        Rook: "HP 28/30 | Poisoned",
      },
      styleName: "arcane",
      variant: "combat",
    });

    expect(result).toContain("Aldric: HP 45/50 | Blessed");
    expect(result).toContain("Rook: HP 28/30 | Poisoned");
    expect(result).toContain("UI: style=arcane, variant=combat");
  });

  it("returns style line even with empty modelines", () => {
    const result = buildUIState({
      modelines: {},
      styleName: "gothic",
      variant: "exploration",
    });

    expect(result).toBeDefined();
    expect(result).toBe("UI: style=gothic, variant=exploration");
    expect(result).not.toContain("Modelines");
  });
});

describe("buildActiveState", () => {
  it("includes resource values when provided", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
      resourceValues: {
        Aldric: { HP: "24/30", "Spell Slots": "3/4" },
      },
    });

    expect(result).toContain("Resources:");
    expect(result).toContain("Aldric: HP=24/30, Spell Slots=3/4");
  });

  it("omits resources section when not provided", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
    });

    expect(result).not.toContain("Resources:");
  });

  it("omits resources section when empty", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
      resourceValues: {},
    });

    expect(result).not.toContain("Resources:");
  });

  it("includes multiple characters", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric", "Rook"],
      pendingAlarms: [],
      resourceValues: {
        Aldric: { HP: "24/30" },
        Rook: { HP: "28/30" },
      },
    });

    expect(result).toContain("Aldric: HP=24/30");
    expect(result).toContain("Rook: HP=28/30");
  });
});
