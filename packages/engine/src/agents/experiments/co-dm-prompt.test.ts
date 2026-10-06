import { migrateForegroundPrompt } from "./co-dm-prompt.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { loadModelConfig } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

describe("isolated co-DM prompt migration", () => {
  beforeEach(() => { resetPromptCache(); loadModelConfig({ reset: true }); });

  it("routes accepted substantial missions to the existing objective tracker without promoting offered hooks", () => {
    const prompt = loadPrompt("co-dm", "gpt-6.1-sol");
    expect(prompt).toContain("Use manage_objectives for the existing objective tracker");
    expect(prompt).toContain("list current objectives and add the accepted mission if absent");
    expect(prompt).toContain("inspecting an item or asking about terms is not agreement");
    expect(prompt).toContain("do not create a second quest list in knowledge");
    expect(prompt).toContain("after reload or later observations");
    expect(prompt).toContain("Do not turn every small promise");
  });

  it("preserves the earned player agency, narration, mechanics and image guidance", () => {
    const source = loadPrompt("dm-directives", "gpt-6.1-sol");
    const migrated = migrateForegroundPrompt([{ text: source }, { text: "Frozen campaign tree" }]);
    for (const tag of ["roles", "gameplay", "About_NPCs", "About_Pacing", "About_Mechanics", "formatting"]) {
      const original = source.match(new RegExp(`^<${tag}>[\\s\\S]*?</${tag}>`, "m"))?.[0];
      expect(migrated[0].text).toContain(original);
    }
    expect(migrated[0].text).toContain("Treat every render as a **one-time introduction**");
    expect(migrated[0].text).toContain("All of this discipline is set aside the moment a player explicitly asks");
    expect(migrated[0].text).not.toContain("Use `scribe` to record narrative state changes");
    expect(migrated[0].text).toContain("<co_dm>private annotation</co_dm>");
    expect(migrated[1].text).toBe("Frozen campaign tree");
    expect(migrated.map(block => block.text).join("").match(/<co_dm_ownership>/g)).toHaveLength(1);
    expect(source).toContain("Use `scribe` to record narrative state changes");
  });
});
