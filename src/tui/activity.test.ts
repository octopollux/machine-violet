import { describe, it, expect } from "vitest";
import { getActivity, getToolGlyph, ACTIVITY_MAP, parseRetryState, retryLabel } from "./activity.js";

describe("activity indicators", () => {
  it("returns indicator for known states", () => {
    const indicator = getActivity("roll_dice");
    expect(indicator).toBeDefined();
    expect(indicator!.label).toBe("Rolling...");
    expect(indicator!.glyph).toBe("⚄");
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
    expect(ACTIVITY_MAP.roll_dice).toBeDefined();
    expect(ACTIVITY_MAP.rule_lookup).toBeDefined();
    expect(ACTIVITY_MAP.scene_transition).toBeDefined();
    expect(ACTIVITY_MAP.dm_thinking).toBeDefined();
  });
});

describe("parseRetryState", () => {
  it("parses valid retry state strings", () => {
    expect(parseRetryState("retry:429:10")).toEqual({ status: 429, delaySec: 10 });
    expect(parseRetryState("retry:0:5")).toEqual({ status: 0, delaySec: 5 });
    expect(parseRetryState("retry:529:30")).toEqual({ status: 529, delaySec: 30 });
  });

  it("returns null for non-retry states", () => {
    expect(parseRetryState("dm_thinking")).toBeNull();
    expect(parseRetryState("retry:abc:10")).toBeNull();
    expect(parseRetryState("")).toBeNull();
  });
});

describe("retryLabel", () => {
  it("returns 'Connection lost' for status 0", () => {
    expect(retryLabel(0)).toBe("Connection lost");
  });

  it("returns 'Rate limited' for 429", () => {
    expect(retryLabel(429)).toBe("Rate limited");
  });

  it("returns 'API overloaded' for 529", () => {
    expect(retryLabel(529)).toBe("API overloaded");
  });

  it("returns generic label for other statuses", () => {
    expect(retryLabel(500)).toBe("API error (500)");
    expect(retryLabel(502)).toBe("API error (502)");
  });
});

describe("getToolGlyph", () => {
  it("returns glyph for known tool names", () => {
    const dice = getToolGlyph("roll_dice");
    expect(dice).toBeDefined();
    expect(dice!.glyph).toBe("⚄");
    expect(dice!.color).toBe("yellow");
  });

  it("returns colored glyphs for combat tools", () => {
    const combat = getToolGlyph("start_combat");
    expect(combat).toBeDefined();
    expect(combat!.glyph).toBe("⚔");
    expect(combat!.color).toBe("red");
  });

  it("returns glyph for map tools", () => {
    expect(getToolGlyph("move_entity")!.glyph).toBe("◈");
    expect(getToolGlyph("view_area")!.glyph).toBe("◈");
    expect(getToolGlyph("create_map")!.glyph).toBe("◈");
  });

  it("returns glyph for entity/scribe tools", () => {
    expect(getToolGlyph("scribe")!.glyph).toBe("✎");
    expect(getToolGlyph("dm_notes")!.glyph).toBe("✎");
  });

  it("returns undefined for unknown tool names", () => {
    expect(getToolGlyph("nonexistent_tool")).toBeUndefined();
  });
});

describe("getActivity ignores retry states (handled by ApiErrorModal)", () => {
  it("returns undefined for retry states", () => {
    expect(getActivity("retry:429:10")).toBeUndefined();
    expect(getActivity("retry:0:5")).toBeUndefined();
    expect(getActivity("retry:529:12")).toBeUndefined();
  });
});
