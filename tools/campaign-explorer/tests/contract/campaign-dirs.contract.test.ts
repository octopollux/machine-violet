/**
 * Contract test: validates that campaignDirs() from the main codebase
 * returns the directory structure the Campaign Explorer expects.
 */
import { describe, it, expect } from "vitest";
import { campaignDirs } from "../../../../packages/engine/src/tools/filesystem/scaffold.js";

describe("campaignDirs contract", () => {
  it("returns expected directory names", () => {
    const dirs = campaignDirs("/test/root");
    const relDirs = dirs.map((d) =>
      d.replace(/\\/g, "/").replace("/test/root", "").replace(/^\//, ""),
    );

    // The explorer relies on these being present
    expect(relDirs).toContain("");           // root itself
    expect(relDirs).toContain("campaign");
    expect(relDirs).toContain("campaign/scenes");
    expect(relDirs).toContain("campaign/session-recaps");
    expect(relDirs).toContain("characters");
    expect(relDirs).toContain("locations");
    expect(relDirs).toContain("factions");
    expect(relDirs).toContain("lore");
    expect(relDirs).toContain("items");
    expect(relDirs).toContain("rules");
    expect(relDirs).toContain("state");
  });
});
