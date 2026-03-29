import { describe, it, expect } from "vitest";
import {
  renderCampaignLog,
  parseLegacyLog,
  formatFullEntry,
  formatMiniEntry,
} from "./campaign-log.js";
import type { CampaignLog, CampaignLogEntry } from "./campaign-log.js";

function makeEntry(n: number, fullLength = 100): CampaignLogEntry {
  // Generate a full summary of approximately `fullLength` characters
  const bullet = `- Event ${n} happened with [[Character${n}]]`;
  const repeats = Math.max(1, Math.ceil(fullLength / bullet.length));
  const full = Array.from({ length: repeats }, (_, i) =>
    `- Event ${n}.${i + 1} happened with [[Character${n}]]`,
  ).join("\n");
  return {
    sceneNumber: n,
    title: `Scene Title ${n}`,
    full,
    mini: `[[Character${n}]] did something important in scene ${n}.`,
  };
}

describe("renderCampaignLog", () => {
  it("returns empty string for empty log", () => {
    const log: CampaignLog = { campaignName: "Test", entries: [] };
    expect(renderCampaignLog(log)).toBe("");
  });

  it("renders single scene as full (never mini)", () => {
    const log: CampaignLog = {
      campaignName: "Dragon's Eye",
      entries: [makeEntry(1)],
    };
    const output = renderCampaignLog(log, 100);
    expect(output).toContain("# Campaign Log: Dragon's Eye");
    expect(output).toContain("## Scene 1: Scene Title 1");
    // Should NOT have mini bullet format
    expect(output).not.toMatch(/^- Scene 1:/m);
  });

  it("includes campaignName in header", () => {
    const log: CampaignLog = {
      campaignName: "The Lost Kingdom",
      entries: [makeEntry(1)],
    };
    expect(renderCampaignLog(log)).toContain("# Campaign Log: The Lost Kingdom");
  });

  it("budget exceeded → older scenes switch to mini", () => {
    // Create 5 scenes with ~200 chars each in full → ~50 tokens each
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(i + 1, 200));
    const log: CampaignLog = { campaignName: "Test", entries };

    // Budget of 75 tokens → should fit ~1.5 full entries, so most recent 1 stays full,
    // the rest go to mini
    const output = renderCampaignLog(log, 75);

    // Scene 5 (most recent) should always be full
    expect(output).toContain("## Scene 5:");
    // Older scenes should have mini format
    expect(output).toMatch(/^- Scene 1:/m);
  });

  it("single scene over budget → still included as full", () => {
    const bigEntry = makeEntry(1, 10000);
    const log: CampaignLog = { campaignName: "Test", entries: [bigEntry] };

    // Budget of 10 tokens — way too small, but should still include
    const output = renderCampaignLog(log, 10);
    expect(output).toContain("## Scene 1:");
  });

  it("determinism: same input = same output", () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1, 150));
    const log: CampaignLog = { campaignName: "Test", entries };

    const output1 = renderCampaignLog(log, 200);
    const output2 = renderCampaignLog(log, 200);
    expect(output1).toBe(output2);
  });

  it("all scenes fit within budget → all rendered as full", () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry(i + 1, 50));
    const log: CampaignLog = { campaignName: "Test", entries };

    const output = renderCampaignLog(log, 100000);
    // All should be full
    expect(output).toContain("## Scene 1:");
    expect(output).toContain("## Scene 2:");
    expect(output).toContain("## Scene 3:");
    // No mini bullets
    expect(output).not.toMatch(/^- Scene \d+:/m);
  });

  it("mini entries use single-line bullet format", () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry(i + 1, 500));
    const log: CampaignLog = { campaignName: "Test", entries };

    // Tiny budget — only latest fits
    const output = renderCampaignLog(log, 50);
    // Scene 1 and 2 should be mini
    const miniLines = output.split("\n").filter((l) => l.match(/^- Scene \d+:/));
    expect(miniLines.length).toBeGreaterThanOrEqual(1);
    // Mini lines should contain the mini text (the one-liner)
    expect(miniLines[0]).toContain("—");
  });
});

describe("formatFullEntry", () => {
  it("renders as ## Scene block", () => {
    const entry: CampaignLogEntry = {
      sceneNumber: 3,
      title: "The Goblin Camp",
      full: "- Scouted the perimeter\n- Found 12 goblins",
      mini: "Party scouted the goblin camp.",
    };
    const result = formatFullEntry(entry);
    expect(result).toContain("## Scene 3: The Goblin Camp");
    expect(result).toContain("- Scouted the perimeter");
    expect(result).toContain("- Found 12 goblins");
  });
});

describe("formatMiniEntry", () => {
  it("renders as single-line bullet", () => {
    const entry: CampaignLogEntry = {
      sceneNumber: 1,
      title: "Tavern Meeting",
      full: "- Met Greta\n- Purchased supplies",
      mini: "[[Aldric]] met [[Greta]] at the [[Rusty Anchor]].",
    };
    const result = formatMiniEntry(entry);
    expect(result).toBe("- Scene 1: Tavern Meeting — [[Aldric]] met [[Greta]] at the [[Rusty Anchor]].");
  });
});

describe("parseLegacyLog", () => {
  it("parses multi-scene markdown", () => {
    const md = [
      "# Campaign Log: Dragon's Eye",
      "",
      "A campaign of mystery and danger.",
      "",
      "## Scene 1: Tavern Meeting",
      "- [[Aldric]] entered the [[Rusty Anchor]] tavern",
      "- Met [[Greta]] the innkeeper",
      "",
      "## Scene 2: Road Ambush",
      "- Ambushed by wolves on the road",
      "- [[Aldric]] took 8 slashing damage",
    ].join("\n");

    const log = parseLegacyLog(md);
    expect(log.campaignName).toBe("Dragon's Eye");
    expect(log.entries).toHaveLength(2);

    expect(log.entries[0].sceneNumber).toBe(1);
    expect(log.entries[0].title).toBe("Tavern Meeting");
    expect(log.entries[0].full).toContain("[[Aldric]] entered");
    expect(log.entries[0].full).toContain("Met [[Greta]]");
    // Mini fallback = first bullet text
    expect(log.entries[0].mini).toContain("[[Aldric]] entered");

    expect(log.entries[1].sceneNumber).toBe(2);
    expect(log.entries[1].title).toBe("Road Ambush");
  });

  it("handles empty log (header only)", () => {
    const md = "# Campaign Log: Empty\n\nNo scenes yet.";
    const log = parseLegacyLog(md);
    expect(log.campaignName).toBe("Empty");
    expect(log.entries).toHaveLength(0);
  });

  it("handles missing header gracefully", () => {
    const md = "## Scene 1: Test\n- Something happened";
    const log = parseLegacyLog(md);
    expect(log.campaignName).toBe("");
    expect(log.entries).toHaveLength(1);
  });

  it("skips scenes without bullets", () => {
    const md = [
      "# Campaign Log: Test",
      "",
      "## Scene 1: Has Bullets",
      "- Event one",
      "",
      "## Scene 2: No Bullets",
      "Just a paragraph, no bullets.",
      "",
      "## Scene 3: Also Has Bullets",
      "- Event three",
    ].join("\n");

    const log = parseLegacyLog(md);
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0].sceneNumber).toBe(1);
    expect(log.entries[1].sceneNumber).toBe(3);
  });
});
