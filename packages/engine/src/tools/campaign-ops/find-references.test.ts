import { describe,it,expect } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import { findReferences } from "./find-references.js";
describe("findReferences",()=>{
  it("reports typed and explicit graph edges, while prose is inert",async()=>{
    const store=new SqliteKnowledgeStore(":memory:");const io={campaignKnowledge:async()=>store} as FileIO;
    await store.mutate([{op:"upsert",collection:"Characters",name:"Bob"},{op:"upsert",collection:"Lore",name:"Plot",fields:{hero:{$ref:"Bob"}}},{op:"upsert",collection:"Lore",name:"Rumor",body:"Bob was here"},{op:"add_reference",source:"Rumor",target:"Bob",label:"involves"}]);
    const result=await findReferences("/camp",io,"Bob");
    expect(result.references).toHaveLength(2);
    expect(result.references.map(ref=>ref.display)).toContain("involves");
    expect(result.references.every(ref=>ref.file.startsWith("knowledge:"))).toBe(true);
    await expect(findReferences("/camp",io,"Missing")).rejects.toThrow("Unknown");
  });
});
