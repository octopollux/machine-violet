import { describe, it, expect } from "vitest";
import { getActivity, ACTIVITY_MAP } from "./activity.js";

describe("activity indicators", () => {
  it("returns indicator for known states", () => {
    const indicator = getActivity("resolve_action");
    expect(indicator).toBeDefined();
    expect(indicator!.label).toBe("Resolving...");
    expect(indicator!.glyph).toBe("⚔");
  });

  it("returns dm_thinking indicator", () => {
    const indicator = getActivity("dm_thinking");
    expect(indicator!.label).toContain("DM");
    expect(indicator!.glyph).toBe("◆");
  });

  it("returns undefined for null state", () => {
    expect(getActivity(null)).toBeUndefined();
  });

  it("returns undefined for unknown state", () => {
    expect(getActivity("unknown_operation")).toBeUndefined();
  });

  it("has all expected activity states", () => {
    expect(ACTIVITY_MAP.resolve_action).toBeDefined();
    expect(ACTIVITY_MAP.roll_dice).toBeDefined();
    expect(ACTIVITY_MAP.rule_lookup).toBeDefined();
    expect(ACTIVITY_MAP.scene_transition).toBeDefined();
    expect(ACTIVITY_MAP.dm_thinking).toBeDefined();
  });
});
