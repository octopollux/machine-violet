import { describe, it, expect } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import { renameEntity, rewriteLinks } from "./rename-entity.js";
describe("rewriteLinks", () => {
  it("rewrites matching link targets", () => {
    const content = "Met [Kael](../characters/kael.md) at the tavern.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe("Met [Kael](../characters/kael-the-ranger.md) at the tavern.");
    expect(result.count).toBe(1);
  });

  it("does not rewrite non-matching links", () => {
    const content = "Met [Goblin](../characters/goblin.md) in battle.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe(content);
    expect(result.count).toBe(0);
  });

  it("rewrites multiple links on different lines", () => {
    const content =
      "[Kael](../characters/kael.md) fought bravely.\n[Kael](../characters/kael.md) rested.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toContain("kael-the-ranger.md");
    expect(result.count).toBe(2);
    expect(result.content).not.toContain("(../characters/kael.md)");
  });

  it("rewrites deep relative paths correctly", () => {
    const content = "[Kael](../../../characters/kael.md) enters the scene.";
    const result = rewriteLinks(
      content,
      "campaign/scenes/001-tavern/transcript.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe(
      "[Kael](../../../characters/kael-the-ranger.md) enters the scene.",
    );
    expect(result.count).toBe(1);
  });
});

describe("renameEntity SQLite identity", () => {
  it("retains UID, old handles and incoming references without prose/file rewriting",async()=>{
    const store=new SqliteKnowledgeStore(":memory:");const io={campaignKnowledge:async()=>store} as FileIO;
    await store.mutate([{op:"upsert",collection:"Characters",name:"Kael",fields:{placeholder:true}},{op:"upsert",collection:"Lore",name:"Story",body:"Kael entered",fields:{hero:{$ref:"Kael"}}}]);
    const uid=await store.resolve("Kael");
    await renameEntity("/camp",io,"Kael","Kael the Ranger",true);
    expect((await store.read("Kael")).name).toBe("Kael");
    await renameEntity("/camp",io,"Kael","Kael the Ranger",false);
    expect(await store.resolve("Kael the Ranger")).toBe(uid);
    expect((await store.read("Kael")).fields.placeholder).toBeUndefined();
    expect((await store.read("Story")).fields.hero).toEqual({$ref:uid});
    expect((await store.read("Story")).body).toBe("Kael entered");
  });
  it("rejects unknown sources and occupied identity handles",async()=>{
    const store=new SqliteKnowledgeStore(":memory:");const io={campaignKnowledge:async()=>store} as FileIO;
    await store.mutate([{op:"upsert",collection:"Characters",name:"Kael"},{op:"upsert",collection:"Characters",name:"Bob"}]);
    await expect(renameEntity("/camp",io,"Missing","New",false)).rejects.toThrow("Unknown");
    await expect(renameEntity("/camp",io,"Kael","Bob",false)).rejects.toThrow("already exists");
  });
});
