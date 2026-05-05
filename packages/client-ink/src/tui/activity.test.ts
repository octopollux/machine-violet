import { describe, it, expect } from "vitest";
import {
  getActivity,
  getActivityLabel,
  hasElapsedAwareLabel,
  getToolGlyph,
  ACTIVITY_MAP,
  parseRetryState,
  retryLabel,
} from "./activity.js";

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
    expect(ACTIVITY_MAP.starting_session).toBeDefined();
  });

  it("returns starting_session indicator for setup→game handoff", () => {
    const indicator = getActivity("starting_session");
    expect(indicator).toBeDefined();
    expect(indicator!.label).toMatch(/preparing|setting/i);
    expect(indicator!.glyph).toBe("◆");
  });
});

describe("getActivityLabel", () => {
  it("returns base label below first tier threshold", () => {
    expect(getActivityLabel("starting_session", 0)).toBe("Preparing your campaign...");
    expect(getActivityLabel("starting_session", 14)).toBe("Preparing your campaign...");
  });

  it("escalates to next tier once threshold is reached", () => {
    expect(getActivityLabel("starting_session", 15)).toBe("Setting the scene...");
    expect(getActivityLabel("starting_session", 44)).toBe("Setting the scene...");
    expect(getActivityLabel("starting_session", 45)).toBe("Almost there...");
    expect(getActivityLabel("starting_session", 200)).toBe("Almost there...");
  });

  it("returns base label for states without tiers", () => {
    expect(getActivityLabel("roll_dice", 0)).toBe("Rolling...");
    expect(getActivityLabel("roll_dice", 999)).toBe("Rolling...");
  });

  it("escalates dm_thinking after long waits", () => {
    expect(getActivityLabel("dm_thinking", 0)).toBe("The DM is thinking...");
    expect(getActivityLabel("dm_thinking", 30)).toBe("The DM is composing the scene...");
    expect(getActivityLabel("dm_thinking", 75)).toBe("The DM is still working...");
  });

  it("escalates tool_running so subagent-backed tools don't blank the line", () => {
    expect(getActivityLabel("tool_running", 0)).toBe("The DM is working...");
    expect(getActivityLabel("tool_running", 15)).toBe("Working on the world...");
    expect(getActivityLabel("tool_running", 45)).toBe("Still working...");
  });

  it("returns undefined for null or unknown state", () => {
    expect(getActivityLabel(null, 0)).toBeUndefined();
    expect(getActivityLabel("nope", 0)).toBeUndefined();
  });
});

describe("hasElapsedAwareLabel", () => {
  it("is true only for states that declare tier escalations", () => {
    // Known-slow states with tiers
    expect(hasElapsedAwareLabel("dm_thinking")).toBe(true);
    expect(hasElapsedAwareLabel("tool_running")).toBe(true);
    expect(hasElapsedAwareLabel("starting_session")).toBe(true);
    // Mapped but tier-less — fast states should NOT trigger ticker/suffix
    expect(hasElapsedAwareLabel("roll_dice")).toBe(false);
    expect(hasElapsedAwareLabel("rule_lookup")).toBe(false);
    expect(hasElapsedAwareLabel("scene_transition")).toBe(false);
  });

  it("is false for null or unmapped states", () => {
    expect(hasElapsedAwareLabel(null)).toBe(false);
    expect(hasElapsedAwareLabel("waiting_input")).toBe(false);
    expect(hasElapsedAwareLabel("nope")).toBe(false);
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
    expect(getToolGlyph("map")!.glyph).toBe("◈");
    expect(getToolGlyph("map_entity")!.glyph).toBe("◈");
    expect(getToolGlyph("map_query")!.glyph).toBe("◈");
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
