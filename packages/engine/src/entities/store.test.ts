import {describe,it,expect,vi} from "vitest";
import {EntityStore,EntityNotFoundError,EntityValidationError,resolveEntityTypeField} from "./store.js";
import type {EntityFileIO} from "./store.js";
import {SqliteKnowledgeStore} from "../knowledge/sqlite-store.js";
function fixture(){
  const knowledge=new SqliteKnowledgeStore(":memory:");
  const io={campaignKnowledge:async()=>knowledge,readFile:vi.fn(),writeFile:vi.fn(),mkdir:vi.fn(),exists:vi.fn(),listDir:vi.fn(),deleteFile:vi.fn()} as EntityFileIO;
  return {knowledge,io,store:new EntityStore("/camp",io)};
}
describe("EntityStore SQLite facade",()=>{
  it("creates typed state with canonical short IDs and renders a specialized sheet",async()=>{
    const {store,io}=fixture();const record=await store.create("character",{displayName:"Bob",frontMatter:{type:"PC",hp:4,additional_names:"Shadow, Hat"},body:"A ranger",changelogEntry:"Arrived"},3);
    expect(record.id).toMatch(/^k[0-9a-z]+$/);expect(record.frontMatter).toMatchObject({type:"PC",hp:4});
    expect(record.aliases).toContain("Shadow");expect(record.raw).toContain("# Bob");expect(record.raw).toContain("A ranger");
    expect((await store.read("character","Hat")).id).toBe(record.id);
    expect(io.writeFile).not.toHaveBeenCalled();expect(io.readFile).not.toHaveBeenCalled();
  });
  it("retains identity and aliases through reveal, partial fields and history updates",async()=>{
    const {store}=fixture();const record=await store.create("character",{displayName:"Shadow",frontMatter:{type:"NPC",hp:4,traits:{hat:true,cloak:true},temporary:true}});
    const updated=await store.update("character",record.id,{displayName:"Bob",frontMatter:{hp:3,traits:{hat:false},temporary:null},changelogEntry:"Revealed"},4);
    expect(updated.id).toBe(record.id);expect(updated.displayName).toBe("Bob");expect(updated.frontMatter).toMatchObject({type:"NPC",hp:3,traits:{hat:false,cloak:true}});
    expect(updated.frontMatter.temporary).toBeUndefined();expect((await store.read("character","Shadow")).displayName).toBe("Bob");
    expect(updated.changelog.join("\n")).toContain("Revealed");
  });
  it("lists/indexes generic identities beneath nested categories",async()=>{
    const {store,knowledge}=fixture();await knowledge.mutate([{op:"create_collection",parent:"Characters",name:"Enemies"},{op:"upsert",collection:"Characters/Enemies",name:"Goblin"},{op:"create_collection",name:"Spells"},{op:"upsert",collection:"Spells",name:"Fireball"}]);
    expect((await store.list("character")).map(item=>item.displayName)).toEqual(["Goblin"]);
    const tree=await store.scanIndex();expect(Object.values(tree).find(item=>item.name==="Fireball")?.type).toBe("Spells");
    expect(Object.values(tree).every(item=>item.path.startsWith("knowledge:"))).toBe(true);
  });
  it("shows explicit incoming/outgoing dependencies and rejects referenced deletion",async()=>{
    const {store,knowledge}=fixture();const bob=await store.create("character",{displayName:"Bob"});
    const plot=await store.create("lore",{displayName:"Plot",frontMatter:{hero:{$ref:bob.id}}});
    expect((await store.read("character",bob.id)).references.inbound).toContain(plot.id);
    expect((await store.read("lore",plot.id)).references.outbound).toContain(bob.id);
    await expect(store.delete("character",bob.id)).rejects.toThrow();
    await knowledge.mutate([{op:"remove_fields",uid:plot.id,keys:["hero"]}]);await store.delete("character",bob.id);
    expect(await store.exists("character",bob.id)).toBe(false);
  });
  it("observes arbitrary fields and detects unreferenced identities",async()=>{
    const {store}=fixture();await store.create("character",{displayName:"Bob",frontMatter:{hp:4,arbitrary:7}});await store.create("character",{displayName:"Jane",frontMatter:{hp:8}});
    expect((await store.scanObservedFields("character")).hp.occursIn).toBe(2);
    expect((await store.scanObservedFields("character")).arbitrary.occursIn).toBe(1);
    expect(await store.detectOrphans()).toHaveLength(2);
  });
  it("rejects missing handles and empty identity names",async()=>{
    const {store}=fixture();await expect(store.read("character","missing")).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(store.update("character","missing",{})).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(store.create("character",{})).rejects.toBeInstanceOf(EntityValidationError);
  });
  it("keeps character role independent of collection type",()=>{
    expect(resolveEntityTypeField("character","PC")).toBe("PC");expect(resolveEntityTypeField("character","character")).toBe("character");
    expect(resolveEntityTypeField("item","Sword")).toBe("item");
  });
});
