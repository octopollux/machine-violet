import { describe, it, expect, beforeEach } from "vitest";
import { buildUIState, buildActiveState, buildHardStats } from "./dm-prompt.js";
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
  it("includes PCs section", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric", "Rook"],
      pendingAlarms: [],
    });
    expect(result).toContain("PCs:");
    expect(result).toContain("Aldric");
    expect(result).toContain("Rook");
  });

  it("includes pending alarms", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: ["Sunset at bell 18"],
    });
    expect(result).toContain("Pending alarms:");
    expect(result).toContain("Sunset at bell 18");
  });

  it("includes active objectives", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
      activeObjectives: ["Find the stolen relic"],
    });
    expect(result).toContain("Objectives:");
    expect(result).toContain("Find the stolen relic");
  });

  it("no longer emits hard-stats fields (resources / turn holder)", () => {
    // Hard numeric state moved to buildHardStats; buildActiveState should not
    // accept or emit those fields. Typing enforces the boundary; this test
    // guards against stringly regressions where "Resources:" or "Turn:" creep
    // back in from unrelated code paths.
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
    });
    expect(result).not.toContain("Resources:");
    expect(result).not.toContain("Turn:");
  });
});

describe("buildHardStats", () => {
  it("renders turn holder and combat round", () => {
    const result = buildHardStats({ turnHolder: "Aldric", combatRound: 3 });
    expect(result).toBe("Turn: Aldric (Round 3)");
  });

  it("renders turn holder without combat round", () => {
    const result = buildHardStats({ turnHolder: "Aldric" });
    expect(result).toBe("Turn: Aldric");
  });

  it("renders resource values", () => {
    const result = buildHardStats({
      resourceValues: { Aldric: { HP: "24/30", "Spell Slots": "3/4" } },
    });
    expect(result).toContain("Resources:");
    expect(result).toContain("Aldric: HP=24/30, Spell Slots=3/4");
  });

  it("renders multiple characters' resources", () => {
    const result = buildHardStats({
      resourceValues: {
        Aldric: { HP: "24/30" },
        Rook: { HP: "28/30" },
      },
    });
    expect(result).toContain("Aldric: HP=24/30");
    expect(result).toContain("Rook: HP=28/30");
  });

  it("returns empty string when nothing to show", () => {
    expect(buildHardStats({})).toBe("");
    expect(buildHardStats({ resourceValues: {} })).toBe("");
    expect(buildHardStats({ resourceValues: { Aldric: {} } })).toBe("");
  });

  it("combines turn holder and resources on separate lines", () => {
    const result = buildHardStats({
      turnHolder: "Aldric",
      resourceValues: { Aldric: { HP: "24/30" } },
    });
    expect(result).toBe("Turn: Aldric\nResources:\n  Aldric: HP=24/30");
  });
});
