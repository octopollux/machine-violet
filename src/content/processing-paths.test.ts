import { processingPaths } from "./processing-paths.js";

/** Normalize backslashes for cross-platform assertions. */
const norm = (p: string) => p.replace(/\\/g, "/");

describe("processingPaths", () => {
  const paths = processingPaths("/home/user/.machine-violet", "d-d-5e");

  it("builds base path under ingest/processed/<slug>", () => {
    expect(norm(paths.base)).toBe(
      "/home/user/.machine-violet/ingest/processed/d-d-5e",
    );
  });

  it("builds pipeline state path", () => {
    expect(norm(paths.pipelineState)).toContain("processed/d-d-5e/pipeline.json");
  });

  it("builds catalog path", () => {
    expect(norm(paths.catalog)).toContain("processed/d-d-5e/catalog.json");
  });

  it("builds draft entity paths", () => {
    expect(norm(paths.draftFile("characters", "goblin"))).toContain(
      "drafts/characters/goblin.md",
    );
    expect(norm(paths.draftCategoryDir("rules"))).toContain("drafts/rules");
  });

  it("builds merged entity paths", () => {
    expect(norm(paths.entityFile("locations", "waterdeep"))).toContain(
      "entities/locations/waterdeep.md",
    );
    expect(norm(paths.entityCategoryDir("factions"))).toContain("entities/factions");
  });

  it("builds index and cheat sheet paths", () => {
    expect(norm(paths.index)).toContain("processed/d-d-5e/index.md");
    expect(norm(paths.cheatSheet)).toContain("processed/d-d-5e/cheat-sheet.md");
  });

  it("builds rule card path", () => {
    expect(norm(paths.ruleCard)).toContain("processed/d-d-5e/rule-card.md");
  });
});
