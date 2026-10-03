import { describe, it, expect } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import { mergeEntities } from "./merge-entities.js";
describe("mergeEntities",()=>{
  it("previews then atomically consolidates aliases, state, logs and incoming dependencies",async()=>{
    const store=new SqliteKnowledgeStore(":memory:"); const io={campaignKnowledge:async()=>store} as FileIO;
    await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",fields:{hp:4},history:"Known"},{op:"upsert",collection:"Characters",name:"Shadow",fields:{hp:1,hat:true},body:"Met at gate",history:"Seen"},{op:"upsert",collection:"Lore",name:"Plot",fields:{suspect:{$ref:"Shadow"}}}]);
    const bob=await store.resolve("Bob"),shadow=await store.resolve("Shadow");
    expect((await mergeEntities("/camp",io,"Bob","Shadow",true)).keysAdded).toEqual(["hat"]);
    expect(await store.resolve("Shadow")).toBe(shadow);
    await mergeEntities("/camp",io,"Bob","Shadow",false);
    expect(await store.resolve("Shadow")).toBe(bob);
    expect(await store.resolve(shadow!)).toBe(bob);
    expect((await store.read("Bob")).fields).toEqual({hp:4,hat:true});
    expect((await store.read("Bob")).logs).toHaveLength(2);
    expect((await store.read("Plot")).fields.suspect).toEqual({$ref:bob});
  });
  it("rejects collection consolidation without changing either identity",async()=>{
    const store=new SqliteKnowledgeStore(":memory:");const io={campaignKnowledge:async()=>store} as FileIO;
    await expect(mergeEntities("/camp",io,"Characters","Lore",false)).rejects.toThrow("narrative");
    expect(await store.resolve("Lore")).not.toBeNull();
  });
});
