import { describe, it, expect, beforeEach } from "vitest";
import { buildUIState } from "./dm-prompt.js";
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
