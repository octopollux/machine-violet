import type { KnowledgeValue } from "@machine-violet/shared/types/knowledge.js";
import { readPublicCampaignRecord } from "../entities/public-knowledge.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { mkdtemp,readFile,rm,copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

describe("SQLite campaign knowledge",()=>{
  let store:SqliteKnowledgeStore;
  beforeEach(()=>{store=new SqliteKnowledgeStore(":memory:");});
  it("creates empty nested collections, stable identities, aliases and typed partial state",async()=>{
    await store.mutate([{op:"create_collection",name:"Spells",note:"Named spells and practitioners"},{op:"create_collection",parent:"Spells",name:"Arcane"}]);
    const result=await store.mutate([{op:"upsert",collection:"Spells/Arcane",name:"Shadowy Figure",fields:{alive:true,hp:7,nothing:null,traits:{hat:"tall",coat:"red"}}}]);
    const uid=result.identities[0].uid;
    await store.mutate([{op:"patch",uid,name:"Bob",aliases:["Tall Hat"],fields:{traits:{hat:"blue"}},history:"Identity revealed"}]);
    const again=await store.mutate([{op:"upsert",collection:"Characters",name:" Shadowy   Figure ",fields:{hp:8}}]);
    expect(again.identities[0].uid).toBe(uid);
    expect(await store.resolve(`@${uid}`)).toBe(uid);
    expect(await store.resolve("tall hat")).toBe(uid);
    expect((await store.read(uid)).name).toBe("Bob");
    expect((await store.read(uid)).fields).toMatchObject({alive:true,hp:8,nothing:null,traits:{hat:"blue",coat:"red"}});
    expect((await store.outline()).some(n=>n.name==="Arcane")).toBe(true);
  });
  it("resolves exact current and historical UIDs without alias or collection-path lookup", async () => {
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "Pansy", aliases: ["King", "Knight", "k123456789"] },
      { op: "upsert", collection: "Characters", name: "Tall Hat" },
    ]);
    const oldUid = (await store.resolve("Pansy"))!;
    const target = (await store.resolve("Tall Hat"))!;
    for (const alias of ["Pansy", "King", "Knight", "k123456789", "Characters", "Characters/Pansy"]) {
      expect(await store.resolve(alias)).not.toBeNull();
      expect(await store.resolveUid(alias)).toBeNull();
    }
    expect(await store.resolveUid(oldUid)).toBe(oldUid);
    await store.mutate([{ op: "consolidate", uid: oldUid, target }]);
    for (const handle of [oldUid, `@${oldUid}`, `knowledge:${oldUid}`, `@knowledge:${oldUid}`]) expect(await store.resolveUid(handle)).toBe(target);
    for (const alias of ["King", "Knight", "k123456789"]) expect(await store.resolveUid(alias)).toBeNull();
    expect(await store.resolveUid(target)).toBe(target);
  });
  it("rejects forged read descriptors atomically while retaining ordinary key names",async()=>{
    await store.mutate([{op:"upsert",collection:"Lore",name:"Secret",fields:{secret:"x".repeat(500)}}]);
    const field=(await store.read("Secret")).children!.find(child=>child.name==="secret")!;
    const notices=await store.pendingNotices();
    await expect(store.mutate([{op:"upsert",collection:"Lore",name:"Public",fields:{summary:{$text:field.uid,length:500}}}])).rejects.toThrow("reserved");
    expect(await store.resolve("Public")).toBeNull();expect(await store.pendingNotices()).toEqual(notices);
    await store.mutate([{op:"upsert",collection:"Lore",name:"Literal",fields:{data:{$text:"ordinary",other:true}}}]);
    expect((await store.read("Literal")).fields.data).toEqual({$text:"ordinary",other:true});
  });
  it("keeps an updated dependent in consequence candidates until explicit acknowledgement",async()=>{
    await store.mutate([{op:"upsert",collection:"Lore",name:"Target"},{op:"upsert",collection:"Lore",name:"Dependent",fields:{target:{$ref:"Target"}}}]);
    const dependent=(await store.resolve("Dependent"))!;
    const result=await store.mutate([{op:"patch",uid:"Target",fields:{burned:true}},{op:"patch",uid:"Dependent",fields:{outcome:"unknown"}}]);
    expect(result.changed).toContain(dependent);expect(result.candidates).toContain(dependent);
    expect((await store.pendingNotices()).at(-1)!.candidates).toContain(dependent);
  });
  it("bounds wide nested field previews and pages their complete typed children",async()=>{
    const details=Object.fromEntries(Array.from({length:200},(_,i)=>[`entry${i}`,i]));
    await store.mutate([{op:"upsert",collection:"Lore",name:"Wide",fields:{details}}]);
    const node=await store.read("Wide");const marker=node.fields.details as {$object:string;length:number};
    expect(marker.length).toBe(200);expect(JSON.stringify(node.fields).length).toBeLessThan(1000);
    const reconstructed:Record<string,unknown>={};
    for(let offset=0;offset<200;offset+=25) Object.assign(reconstructed,(await store.read(marker.$object,{childOffset:offset,childLimit:25})).value);
    expect(reconstructed).toEqual(details);
  });
  it("chunks durable outbox delivery without losing candidate dependencies",async()=>{
    await store.mutate([{op:"upsert",collection:"Lore",name:"Target"},...Array.from({length:205},(_,index)=>({op:"upsert" as const,collection:"Lore",name:`Dependent ${index}`,fields:{target:{$ref:"Target"}}}))]);
    await store.acknowledgeNotices((await store.pendingNotices()).map(notice=>notice.id));
    const result=await store.mutate([{op:"patch",uid:"Target",fields:{burned:true}}]);const notices=await store.pendingNotices();
    expect(notices).toHaveLength(3);expect(notices.every(notice=>notice.candidates.length<=100&&notice.identities.length<=50)).toBe(true);
    expect(notices.flatMap(notice=>notice.candidates)).toEqual(result.candidates);
    await store.acknowledgeNotices([notices[0].id]);expect(await store.pendingNotices()).toHaveLength(2);
  });
  it("retrieves direct and indirect graph candidates cycle-safely with a two-edge bound",async()=>{
    await store.mutate([{op:"upsert",collection:"Locations",name:"Castle"},{op:"upsert",collection:"Lore",name:"Archive",fields:{site:{$ref:"Castle"}}},{op:"upsert",collection:"Lore",name:"Quest",fields:{archive:{$ref:"Archive"}}},{op:"upsert",collection:"Lore",name:"Distant",fields:{quest:{$ref:"Quest"}}},{op:"add_reference",source:"Castle",target:"Quest",label:"cycle"}]);
    const archive=(await store.resolve("Archive"))!,quest=(await store.resolve("Quest"))!,distant=(await store.resolve("Distant"))!;
    const result=await store.mutate([{op:"patch",uid:"Castle",fields:{burned:true}}]);
    expect(result.candidates).toEqual([archive,quest].sort());expect(result.candidates).not.toContain(distant);
  });
  it("preserves referenced missing descendant UIDs on consolidation and rejects conflicting referenced descendants",async()=>{
    await store.mutate([{op:"upsert",collection:"Characters",name:"Source",fields:{unique:{hp:7},conflict:{hp:2}}},{op:"upsert",collection:"Characters",name:"Target",fields:{conflict:{hp:9}}},{op:"upsert",collection:"Lore",name:"Watcher"}]);
    const source=await store.read("Source");const unique=source.children!.find(child=>child.name==="unique")!,conflict=source.children!.find(child=>child.name==="conflict")!;
    const hp=(await store.read(conflict.uid)).children!.find(child=>child.name==="hp")!;
    await store.mutate([{op:"add_reference",source:"Watcher",target:hp.uid}]);const before=await store.snapshot(),notices=await store.pendingNotices();
    await expect(store.mutate([{op:"consolidate",uid:"Source",target:"Target"}])).rejects.toThrow("Move or reconcile");
    expect(await store.snapshot()).toBe(before);expect(await store.pendingNotices()).toEqual(notices);
    await store.mutate([{op:"remove_reference",source:"Watcher",target:hp.uid},{op:"add_reference",source:"Watcher",target:unique.uid}]);
    await store.mutate([{op:"consolidate",uid:"Source",target:"Target"}]);
    expect((await store.read(unique.uid)).parent).toBe(await store.resolve("Target"));
    expect((await store.read("Watcher")).references[0].target).toBe(unique.uid);
    expect((await store.read("Target")).fields).toEqual({unique:{hp:7},conflict:{hp:9}});
  });
  it("commits state, logs and notices together and rolls back a late invalid reference",async()=>{
    const before=await store.outline();
    await expect(store.mutate([{op:"upsert",collection:"Characters",name:"Bob",history:"Born"},{op:"add_reference",source:"Bob",target:"Missing"}])).rejects.toThrow("Unknown");
    expect(await store.resolve("Bob")).toBeNull();
    expect(await store.outline()).toEqual(before);
    expect(await store.pendingNotices()).toEqual([]);
    const result=await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",fields:{hp:1},history:"Injured"}],{operationId:"turn-1",sceneNumber:2});
    expect((await store.read("Bob")).logs[0]).toMatchObject({body:"Injured",metadata:{scene:2}});
    expect((await store.pendingNotices())[0].id).toBe(result.noticeId);
    expect(await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",fields:{hp:1},history:"Injured"}],{operationId:"turn-1",sceneNumber:2})).toEqual(result);
    expect((await store.read("Bob")).logs).toHaveLength(1);
    await expect(store.mutate([],{operationId:"turn-1"})).rejects.toThrow("reused");
  });
  it("defaults append_log provenance to the current scene without changing explicit historical metadata", async () => {
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Chronicle" }]);
    const metadata = { action: "observed" };
    await store.mutate([
      { op: "append_log", uid: "Chronicle", body: "No metadata" },
      { op: "append_log", uid: "Chronicle", body: "Empty metadata", metadata: {} },
      { op: "append_log", uid: "Chronicle", body: "Extra metadata", metadata },
      { op: "append_log", uid: "Chronicle", body: "Historical scene", metadata: { scene: 1 } },
      { op: "append_log", uid: "Chronicle", body: "Historical sceneNumber", metadata: { sceneNumber: 2 } },
      { op: "append_log", uid: "Chronicle", body: "Explicit zero", metadata: { scene: 0 } },
      { op: "append_log", uid: "Chronicle", body: "Explicit unknown", metadata: { sceneNumber: null } },
    ], { sceneNumber: 3 });
    expect((await store.read("Chronicle")).logs.map(log => log.metadata)).toEqual([
      { scene: 3 }, { scene: 3 }, { action: "observed", scene: 3 },
      { scene: 1 }, { sceneNumber: 2 }, { scene: 0 }, { sceneNumber: null },
    ]);
    expect(metadata).toEqual({ action: "observed" });
    await store.mutate([{ op: "append_log", uid: "Chronicle", body: "Offline entry", metadata: {} }]);
    expect((await store.read("Chronicle")).logs.at(-1)!.metadata).toEqual({});
  });
  it("notifies dependencies on leaves and preserves links on unrelated partial writes",async()=>{
    await store.mutate([{op:"upsert",collection:"Locations",name:"Castle",fields:{burning:false}},{op:"upsert",collection:"Characters",name:"Resident",fields:{home:{$ref:"Castle"}}}]);
    const leaf=(await store.read("Castle")).children![0].uid;
    await store.mutate([{op:"add_reference",source:"Resident",target:leaf,label:"shelter"}]);
    const result=await store.mutate([{op:"set_value",uid:leaf,value:true}]);
    expect(result.candidates).toEqual([await store.resolve("Resident")]);
    await store.mutate([{op:"patch",uid:"Resident",fields:{mood:"worried"}}]);
    expect((await store.read("Resident")).references).toHaveLength(2);
    expect((await store.read("Resident")).fields.home).toEqual({$ref:await store.resolve("Castle")});
    await expect(store.mutate([{op:"delete",uid:"Castle"}])).rejects.toThrow();
  });
  it("consolidates without stale structural edges and retains old UIDs",async()=>{
    await store.mutate([{op:"upsert",collection:"Locations",name:"Castle"},{op:"upsert",collection:"Characters",name:"Shadow",fields:{home:{$ref:"Castle"}}},{op:"upsert",collection:"Characters",name:"Bob"},{op:"upsert",collection:"Lore",name:"Quest",fields:{actor:{$ref:"Shadow"}}}]);
    const old=await store.resolve("Shadow"); const canonical=await store.resolve("Bob");
    await store.mutate([{op:"consolidate",uid:"Shadow",target:"Bob"}]);
    expect(await store.resolve(old!)).toBe(canonical);
    expect((await store.read("Quest")).fields.actor).toEqual({$ref:canonical});
    await store.mutate([{op:"patch",uid:"Bob",fields:{home:"gone"}}]);
    expect((await store.read("Bob")).references).toEqual([]);
    await store.mutate([{op:"delete",uid:"Castle"}]);
  });
  it("preserves ordered duplicate card instance UIDs across moves",async()=>{
    await store.mutate([{op:"create_collection",name:"Decks"},{op:"upsert",collection:"Decks",name:"Deck",fields:{draw:[{face:"AS"},{face:"AS"}],hand:[]}}]);
    const record=await store.read("Deck"); const draw=record.children!.find(n=>n.name==="draw")!.uid; const hand=record.children!.find(n=>n.name==="hand")!.uid;
    const cards=(await store.read(draw)).children!;
    expect(cards[0].uid).not.toBe(cards[1].uid);
    await store.mutate([{op:"move",uid:cards[1].uid,parent:hand,index:0}]);
    expect((await store.read(hand)).children![0].uid).toBe(cards[1].uid);
    expect((await store.read(draw)).children![0].uid).toBe(cards[0].uid);
  });
  it("appends to the actual string leaf while retaining UID, references and full text paging", async () => {
    await store.mutate([
      { op: "upsert", collection: "Lore", name: "Chronicle", fields: { text: "Beginning. ", untouched: true }, body: "Entity body" },
      { op: "upsert", collection: "Lore", name: "Watcher" },
    ]);
    const leaf = (await store.read("Chronicle")).children!.find(node => node.name === "text")!.uid;
    await store.mutate([{ op: "add_reference", source: "Watcher", target: leaf, label: "depends_on" }]);
    const suffix = "continued ".repeat(3000) + "Final discovery.";
    const result = await store.mutate([{ op: "append_text", uid: leaf, text: suffix }]);
    expect(result.candidates).toContain(await store.resolve("Watcher"));
    const owner = await store.read("Chronicle");
    expect(owner.fields.untouched).toBe(true);
    expect(owner.body).toBe("Entity body");
    expect(owner.children!.find(node => node.name === "text")!.uid).toBe(leaf);
    expect(owner.fields.text).toMatchObject({ $text: leaf, length: "Beginning. ".length + suffix.length });
    let recovered = "";
    let offset = 0;
    do {
      const page = await store.read(leaf, { textOffset: offset, textLimit: 2000 });
      recovered += page.value;
      expect(page.body).toBe("");
      offset = page.textNextOffset ?? 0;
    } while (offset);
    expect(recovered).toBe("Beginning. " + suffix);
    expect((await store.read("Watcher")).references).toContainEqual({ source: (await store.resolve("Watcher"))!, target: leaf, label: "depends_on" });
    await store.mutate([{ op: "append_text", uid: "Chronicle", text: " plus entity prose" }, { op: "append_text", uid: "Lore", text: "Collection prose" }]);
    expect((await store.read("Chronicle")).body).toBe("Entity body plus entity prose");
    expect((await store.read("Lore")).body).toBe("Collection prose");
  });
  it.each([null, 7, false, {}, [], { $ref: "Lore" }].map(value => ({ value: value as KnowledgeValue })))("rejects appending text to a non-string typed value ($value) atomically", async ({ value }) => {
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Record", fields: { value }, body: "Original" }]);
    const leaf = (await store.read("Record")).children![0].uid;
    const before = await store.snapshot();
    const notices = await store.pendingNotices();
    await expect(store.mutate([{ op: "append_text", uid: "Record", text: " rolled back" }, { op: "append_text", uid: leaf, text: "invalid" }])).rejects.toThrow("append_text requires a string value");
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual(notices);
    expect((await store.read("Record")).body).toBe("Original");
  });
  it("preserves explicit value: labels when appending or replacing a scalar field", async () => {
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Chronicle", fields: { text: "Beginning" } }, { op: "upsert", collection: "Lore", name: "Other" }]);
    const uid = (await store.resolve("Chronicle"))!; const other = (await store.resolve("Other"))!;
    const leaf = (await store.read(uid)).children![0].uid;
    const edge = { source: uid, target: other, label: `value:${leaf}` };
    await store.mutate([{ op: "add_reference", ...edge }]);
    await store.mutate([{ op: "append_text", uid: leaf, text: " continued" }]);
    expect((await store.read(leaf)).value).toBe("Beginning continued");
    expect((await store.read(uid)).references).toContainEqual(edge);
    await store.mutate([{ op: "patch", uid, fields: { text: "Replacement" } }]);
    expect((await store.read(uid)).references).toContainEqual(edge);
  });
  it("removes only matching structural edges when changing references or removing nested fields", async () => {
    await store.mutate([
      { op: "upsert", collection: "Lore", name: "Old" }, { op: "upsert", collection: "Lore", name: "New" }, { op: "upsert", collection: "Lore", name: "Other" },
      { op: "upsert", collection: "Lore", name: "Record", fields: { nested: { relation: { $ref: "Old" } }, temporary: "Text" } },
    ]);
    const uid = (await store.resolve("Record"))!; const other = (await store.resolve("Other"))!;
    const nested = (await store.read(uid)).children!.find(node => node.name === "nested")!.uid;
    const leaf = (await store.read(nested)).children![0].uid;
    const temporary = (await store.read(uid)).children!.find(node => node.name === "temporary")!.uid;
    const edges = [leaf, temporary].map(node => ({ source: uid, target: other, label: `value:${node}` }));
    await store.mutate(edges.map(edge => ({ op: "add_reference", ...edge })));
    await store.mutate([{ op: "set_value", uid: leaf, value: { $ref: "New" } }]);
    let references = (await store.read(uid)).references;
    expect(references).not.toContainEqual({ source: uid, target: (await store.resolve("Old"))!, label: `value:${leaf}` });
    expect(references).toContainEqual({ source: uid, target: (await store.resolve("New"))!, label: `value:${leaf}` });
    expect(references).toEqual(expect.arrayContaining(edges));
    await store.mutate([{ op: "set_value", uid: nested, value: {} }, { op: "remove_fields", uid, keys: ["temporary"] }]);
    references = (await store.read(uid)).references;
    expect(references).toEqual(expect.arrayContaining(edges));
    expect(references).not.toContainEqual({ source: uid, target: (await store.resolve("New"))!, label: `value:${leaf}` });
  });
  it("transfers only the actual reference edge when a nested value changes owners", async () => {
    await store.mutate([
      { op: "upsert", collection: "Lore", name: "Target" }, { op: "upsert", collection: "Lore", name: "Other" },
      { op: "upsert", collection: "Lore", name: "From", fields: { nested: { text: "Text", relation: { $ref: "Target" } } } },
      { op: "upsert", collection: "Lore", name: "To", fields: { received: {} } },
    ]);
    const from = (await store.resolve("From"))!; const to = (await store.resolve("To"))!;
    const nested = (await store.read(from)).children![0].uid; const children = (await store.read(nested)).children!;
    const text = children.find(node => node.name === "text")!.uid; const relation = children.find(node => node.name === "relation")!.uid;
    const received = (await store.read(to)).children![0].uid; const other = (await store.resolve("Other"))!; const target = (await store.resolve("Target"))!;
    const explicit = [text, relation].map(uid => ({ source: from, target: other, label: `value:${uid}` }));
    await store.mutate(explicit.map(edge => ({ op: "add_reference", ...edge })));
    await store.mutate([{ op: "move", uid: nested, parent: received }]);
    expect((await store.read(from)).references).toEqual(expect.arrayContaining(explicit));
    expect((await store.read(from)).references).not.toContainEqual({ source: from, target, label: `value:${relation}` });
    expect((await store.read(to)).references).toContainEqual({ source: to, target, label: `value:${relation}` });
    expect((await store.read(to)).references).not.toEqual(expect.arrayContaining(explicit.map(edge => ({ ...edge, source: to }))));
  });
  it("consolidates explicit value: labels while dropping only discarded fields' actual edges", async () => {
    await store.mutate([
      { op: "upsert", collection: "Lore", name: "Other" }, { op: "upsert", collection: "Lore", name: "Elsewhere" },
      { op: "upsert", collection: "Lore", name: "Source", fields: { text: "Old prose", relation: { $ref: "Other" }, retained: { $ref: "Other" } } },
      { op: "upsert", collection: "Lore", name: "Winner", fields: { text: "Current prose", relation: { $ref: "Elsewhere" } } },
    ]);
    const source = (await store.resolve("Source"))!; const winner = (await store.resolve("Winner"))!;
    const other = (await store.resolve("Other"))!; const elsewhere = (await store.resolve("Elsewhere"))!;
    const children = (await store.read(source)).children!;
    const text = children.find(node => node.name === "text")!.uid;
    const relation = children.find(node => node.name === "relation")!.uid;
    const retained = children.find(node => node.name === "retained")!.uid;
    const explicit = [
      { source, target: elsewhere, label: `value:${text}` },
      { source, target: elsewhere, label: `value:${relation}` },
      { source, target: other, label: "value:custom-label" },
    ];
    await store.mutate(explicit.map(edge => ({ op: "add_reference", ...edge })));
    await store.mutate([{ op: "consolidate", uid: source, target: winner }]);
    const node = await store.read(winner);
    expect(node.references).toEqual(expect.arrayContaining(explicit.map(edge => ({ ...edge, source: winner }))));
    expect(node.references).not.toContainEqual({ source: winner, target: other, label: `value:${relation}` });
    expect(node.references).toContainEqual({ source: winner, target: other, label: `value:${retained}` });
    expect((await store.read(retained)).parent).toBe(winner);
    expect(node.fields).toMatchObject({ text: "Current prose", relation: { $ref: elsewhere }, retained: { $ref: other } });
    expect(await store.resolveUid(source)).toBe(winner);
  });
  it("pages long individual history entries without advertising a misleading global history cursor", async () => {
    const text = "long history ".repeat(1000);
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Chronicle" }, ...Array.from({ length: 40 }, (_, index) => ({ op: "append_log" as const, uid: "Chronicle", body: index === 39 ? text : `Entry ${index}` }))]);
    const firstPage = await store.read("Chronicle", { logLimit: 30 });
    expect(firstPage.logNextOffset).toBe(30);
    const lastPage = await store.read("Chronicle", { logOffset: 30, logLimit: 30 });
    expect(lastPage.logs).toHaveLength(10);
    expect(lastPage.logNextOffset).toBeUndefined();
    const lastId = lastPage.logs[9].id;
    let recovered = "";
    let offset = 0;
    do {
      const page = await store.read("Chronicle", { logEntryId: lastId, logTextOffset: offset, logTextLimit: 2000 });
      expect(page.logNextOffset).toBeUndefined();
      expect(page.logCount).toBe(40);
      recovered += page.logs[0].body;
      offset = page.logs[0].textNextOffset ?? 0;
    } while (offset);
    expect(recovered).toBe(text);
  });
  it("keeps bulk text out of snapshots and pages bodies, scalar text and history",async()=>{
    const text="x".repeat(40000);
    await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",fields:{biography:text},body:text},{op:"append_log",uid:"Bob",body:text}]);
    const node=await store.read("Bob",{textLimit:100});
    expect(node.body).toHaveLength(100); expect(node.textNextOffset).toBe(100);
    expect(node.fields.biography).toMatchObject({$text:expect.any(String),length:40000});
    const leaf=(await store.read("Bob")).children![0].uid;
    expect((await store.read(leaf,{textOffset:100,textLimit:50})).value).toHaveLength(50);
    expect((await store.snapshot()).length).toBeLessThan(1000);
    expect((await store.snapshot())).toContain(leaf);
    expect(node.logs[0].body).toHaveLength(500);
    let recovered=""; let offset=0;
    do { const entry=(await store.read("Bob",{logEntryId:node.logs[0].id,logTextOffset:offset,logTextLimit:10000})).logs[0]; recovered+=entry.body; offset=entry.textNextOffset ?? 0; } while(offset);
    expect(recovered).toBe(text);
  });
});

describe("compact complete knowledge projection", () => {
  it("keeps every UID, nested/empty structure, ordered instance and meaningful scalar while bounding bulk", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    const bulk = "private bulk ".repeat(5000);
    await store.mutate([
      { op: "create_collection", name: "Quests", note: "Named quests and dependencies" },
      { op: "create_collection", parent: "Quests", name: "Archived" },
      { op: "upsert", collection: "Characters", name: "Shadow", fields: { zero: 0, falseValue: false, empty: null, quote: "A \"name\"\nnew line", stats: { hp: 7 }, cards: [{ face: "AS" }, { face: "AS" }], biography: bulk }, body: bulk, history: bulk },
      { op: "patch", uid: "Shadow", name: "Bob" },
    ]);
    const bob = await store.read("Bob");
    const cards = bob.children!.find(child => child.name === "cards")!.uid;
    await store.mutate([{ op: "create_node", parent: cards, name: "Named Card", value: { face: "AS" }, index: 0 }]);
    const cardNodes = (await store.read(cards)).children!;
    const outline = await store.outline();
    const snapshot = await store.snapshot();
    const lines = snapshot.split("\n");
    const projectedUIDs = lines.map(line => line.trimStart().split(" ")[0]);
    expect(projectedUIDs).toHaveLength(outline.length);
    expect(new Set(projectedUIDs)).toEqual(new Set(outline.map(node => node.uid)));
    expect(snapshot).toBe(await store.snapshot());
    expect(lines[0]).toBe("root Campaign/");
    const quest = outline.find(node => node.name === "Quests")!;
    const archived = outline.find(node => node.name === "Archived")!;
    expect(lines.find(line => line.trimStart().startsWith(`${quest.uid} `))).toContain("Quests/ — Named quests and dependencies");
    expect(lines.find(line => line.trimStart().startsWith(`${archived.uid} `))).toBe(`    ${archived.uid} Archived/`);
    expect(snapshot).toContain(`${bob.uid} Bob aka "Shadow"`);
    expect(snapshot).not.toContain('aka "Bob"');
    expect(snapshot).toContain('zero = 0');
    expect(snapshot).toContain('falseValue = false');
    expect(snapshot).toContain('empty = null');
    expect(snapshot).toContain(`quote = ${JSON.stringify('A "name"\nnew line')}`);
    expect(snapshot).toContain('stats {}');
    expect(snapshot).toContain('hp = 7');
    expect(snapshot).toContain('cards []');
    expect(snapshot).toContain(`${cardNodes[0].uid} [0] Named Card {}`);
    for (let index = 1; index < cardNodes.length; index++) expect(snapshot).toContain(`${cardNodes[index].uid} [${index}] {}`);
    expect(cardNodes.map(node => snapshot.indexOf(`${node.uid} `))).toEqual(cardNodes.map(node => snapshot.indexOf(`${node.uid} `)).sort((a, b) => a - b));
    expect(snapshot).toContain(`biography = (text ${bulk.length} chars)`);
    expect(snapshot).toContain(`(body ${bulk.length} chars, 1 log)`);
    expect(snapshot).not.toContain("private bulk");
    expect(snapshot).not.toMatch(/\[(collection|entity|scalar|reference)\]/);
  });
  it("shows typed reference leaves once and preserves every explicit edge with an implicit source", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "Bob" },
      { op: "upsert", collection: "Locations", name: "Castle" },
      { op: "upsert", collection: "Lore", name: "Quest", fields: { actor: { $ref: "Bob" }, site: { $ref: "Castle" } } },
    ]);
    const quest = await store.read("Quest");
    const actor = quest.children!.find(child => child.name === "actor")!;
    const bob = (await store.resolve("Bob"))!;
    const castle = (await store.resolve("Castle"))!;
    await store.mutate([
      { op: "add_reference", source: quest.uid, target: bob, label: "depends_on" },
      { op: "add_reference", source: quest.uid, target: castle, label: `value:${actor.uid}` },
      { op: "add_reference", source: actor.uid, target: bob, label: `value:${actor.uid}` },
      { op: "add_reference", source: "Castle", target: quest.uid, label: "knows;\nwhy -> then" },
    ]);
    const snapshot = await store.snapshot();
    const questLine = snapshot.split("\n").find(line => line.trimStart().startsWith(`${quest.uid} `))!;
    const actorLine = snapshot.split("\n").find(line => line.trimStart().startsWith(`${actor.uid} `))!;
    expect(questLine).toContain(`links: depends_on -> ${bob}; value:${actor.uid} -> ${castle}`);
    expect(questLine).not.toContain(`value:${actor.uid} -> ${bob}`);
    expect(actorLine).toContain(`actor -> ${bob}; links: value:${actor.uid} -> ${bob}`);
    expect(snapshot).toContain(`site -> ${castle}`);
    expect(snapshot).toContain(`${JSON.stringify("knows;\nwhy -> then")} -> ${quest.uid}`);
    expect(snapshot).not.toContain('"source":');
    expect(snapshot).not.toContain('"$ref":');
  });
  it("projects all children beyond read page limits without selecting relevant fields", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    const fields = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field${index}`, index]));
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Complete Record", fields }]);
    const snapshot = await store.snapshot();
    for (const node of await store.outline()) expect(snapshot.split("\n").some(line => line.trimStart().startsWith(`${node.uid} `))).toBe(true);
    for (const [name, value] of Object.entries(fields)) expect(snapshot).toContain(`${name} = ${value}`);
  });
});

describe("explicit immediate player disclosure", () => {
  let store: SqliteKnowledgeStore;
  beforeEach(() => { store = new SqliteKnowledgeStore(":memory:"); });
  afterEach(async () => { await store.close(); });
  const views = async () => Promise.all((await store.outline()).filter(node => node.kind === "entity" && node.name.startsWith("Player memory:")).map(node => store.read(node.uid)));
  it("publishes supplied safe facts immediately with the canonical UID while leaving all private facts unchanged", async () => {
    await store.mutate([
      { op: "create_collection", parent: "Characters", name: "Visitors" },
      { op: "upsert", collection: "Characters/Visitors", name: "Secret Queen", aliases: ["King", "k123456789"], body: "Unrevealed plans", fields: { password: "private", public_related: ["hidden relation"] } },
    ]);
    const uid = (await store.resolve("Secret Queen"))!;
    const canonical = await store.read(uid);
    const summary = "Approved description ".repeat(1500);
    const result = await store.mutate([{ op: "disclose", uid: "King", name: "Flower Seller", summary, aliases: ["Pansy"] }], { sceneNumber: 3, source: "scribe" });
    expect(result.identities).toContainEqual(expect.objectContaining({ uid }));
    expect(await store.read(uid)).toEqual(canonical);
    for (const handle of [uid, "Flower Seller", "Pansy"]) expect(await readPublicCampaignRecord(store, handle)).toMatchObject({ uid, name: "Flower Seller", content: `# Flower Seller\n\n${summary}`, collection: "Characters/Visitors" });
    for (const handle of ["Secret Queen", "King", "k123456789"]) expect(await readPublicCampaignRecord(store, handle)).toBeNull();
    const [view] = await views();
    expect(view.fields).toMatchObject({ subject: { $ref: uid }, display_name: "Flower Seller", public_aliases: ["Pansy"], firstScene: 3, lastScene: 3 });
    expect(view.fields).not.toHaveProperty("password");
    expect(view.fields).not.toHaveProperty("public_related");
    expect(view.logs[0].metadata).toEqual({ action: "disclose", scene: 3 });
    expect((await store.pendingNotices()).at(-1)!.source).toBe("scribe");
  });
  it("reuses the approved record, preserves approved old handles on a public rename, and keeps retries idempotent", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Hidden Identity", aliases: ["Secret Alias"], body: "Private" }]);
    const uid = (await store.resolve("Hidden Identity"))!;
    const canonical = await store.read(uid);
    await store.mutate([{ op: "disclose", uid, name: "Pansy", summary: "A florist", aliases: ["Flower Seller"] }], { sceneNumber: 3 });
    const firstView = (await views())[0];
    const disclosure = [{ op: "disclose" as const, uid, name: "Lady Gardener", summary: "An expert botanist", aliases: ["Green Thumb"] }];
    const result = await store.mutate(disclosure, { operationId: "reveal-5", sceneNumber: 5 });
    expect(await store.mutate(disclosure, { operationId: "reveal-5", sceneNumber: 5 })).toEqual(result);
    const [view] = await views();
    expect(view.uid).toBe(firstView.uid);
    expect(view.fields).toMatchObject({ display_name: "Lady Gardener", summary: "An expert botanist", public_aliases: ["Pansy", "Flower Seller", "Green Thumb"], firstScene: 3, lastScene: 5 });
    expect(view.logs).toHaveLength(2);
    expect(view.logs[1]).toMatchObject({ body: "Lady Gardener\n\nAn expert botanist", metadata: { action: "disclose", scene: 5 } });
    expect(await views()).toHaveLength(1);
    expect((await store.outline()).filter(node => node.kind === "entity")).toHaveLength(2);
    expect(await store.read(uid)).toEqual(canonical);
    for (const handle of [uid, "Pansy", "Flower Seller", "Green Thumb", "Lady Gardener"]) expect((await readPublicCampaignRecord(store, handle))?.content).toBe("# Lady Gardener\n\nAn expert botanist");
    expect(await readPublicCampaignRecord(store, "Secret Alias")).toBeNull();
  });
  it("rolls creation and existing approved disclosure updates back with the rest of a failed batch", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Secret" }]);
    const uid = (await store.resolve("Secret"))!;
    const before = await store.snapshot();
    const notices = await store.pendingNotices();
    await expect(store.mutate([{ op: "disclose", uid, name: "Known", summary: "Approved" }, { op: "patch", uid: "Missing", body: "invalid" }])).rejects.toThrow("Unknown");
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual(notices);
    expect(await views()).toHaveLength(0);
    await store.mutate([{ op: "disclose", uid, name: "Known", summary: "Approved" }]);
    const approved = await store.snapshot();
    const approvedNotices = await store.pendingNotices();
    await expect(store.mutate([{ op: "disclose", uid, name: "New name", summary: "New approval" }, { op: "patch", uid: "Missing", body: "invalid" }])).rejects.toThrow("Unknown");
    expect(await store.snapshot()).toBe(approved);
    expect(await store.pendingNotices()).toEqual(approvedNotices);
    expect((await readPublicCampaignRecord(store, uid))?.content).toBe("# Known\n\nApproved");
    expect(await readPublicCampaignRecord(store, "New name")).toBeNull();
  });
  it("publishes the latest disclosure across multiple consolidated views regardless of their tree order", async () => {
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "Secret A", aliases: ["Hidden A"] },
      { op: "upsert", collection: "Lore", name: "Secret B", aliases: ["Hidden B"] },
      { op: "disclose", uid: "Secret A", name: "Tall Hat", summary: "First person", aliases: ["Visitor"] },
      { op: "disclose", uid: "Secret B", name: "Stranger", summary: "Second person", aliases: ["Sexton"] },
    ], { sceneNumber: 1 });
    const oldUid = (await store.resolve("Secret A"))!;
    const uid = (await store.resolve("Secret B"))!;
    await store.mutate([{ op: "consolidate", uid: oldUid, target: uid }]);
    const canonical = await store.read(uid);
    await store.mutate([{ op: "disclose", uid: oldUid, name: "Known Helper", summary: "Latest approved facts", aliases: ["Guide"] }], { sceneNumber: 8 });
    const approved = await views();
    expect(approved).toHaveLength(2);
    expect(approved.every(view => view.fields.summary === "Latest approved facts" && view.fields.display_name === "Known Helper" && view.fields.lastScene === 8)).toBe(true);
    expect(await store.read(uid)).toEqual(canonical);
    for (const handle of [oldUid, uid, "Tall Hat", "Visitor", "Stranger", "Sexton", "Known Helper", "Guide"]) expect(await readPublicCampaignRecord(store, handle)).toMatchObject({ uid, content: "# Known Helper\n\nLatest approved facts" });
    for (const hidden of ["Secret A", "Secret B", "Hidden A", "Hidden B"]) expect(await readPublicCampaignRecord(store, hidden)).toBeNull();
  });
  it("retains pre-batch direct public handles without publishing secret aliases added earlier in the disclosure batch", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Bob", aliases: ["Tall Hat"], body: "Known traveler", visibility: "player-facing" }]);
    const uid = (await store.resolve("Bob"))!;
    await store.mutate([
      { op: "patch", uid, aliases: ["Hidden King"], body: "Private plans" },
      { op: "disclose", uid, name: "Captain Bob", summary: "Now a captain", aliases: ["Skipper"] },
    ], { sceneNumber: 6 });
    for (const handle of ["Bob", "Tall Hat", "Captain Bob", "Skipper", uid]) expect(await readPublicCampaignRecord(store, handle)).toMatchObject({ uid, content: "# Captain Bob\n\nNow a captain" });
    expect(await readPublicCampaignRecord(store, "Hidden King")).toBeNull();
    expect((await views())[0].fields.public_aliases).toEqual(["Bob", "Tall Hat", "Skipper"]);
    expect((await store.read(uid)).aliases).toContain("Hidden King");
    expect((await store.read(uid)).body).toBe("Private plans");
  });
  it("rejects a projection target with canonical UID guidance instead of creating recursive public records", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Secret" }, { op: "disclose", uid: "Secret", name: "Known", summary: "Approved" }]);
    const uid = (await store.resolve("Secret"))!;
    const view = (await views())[0];
    const before = await store.snapshot();
    const notices = await store.pendingNotices();
    await expect(store.mutate([{ op: "disclose", uid: view.uid, name: "Recursive", summary: "Invalid target" }])).rejects.toThrow(`canonical UID ${uid}`);
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual(notices);
    expect(await views()).toHaveLength(1);
  });
  it("rejects non-entity and missing targets and requires a nonempty explicit public name", async () => {
    await store.mutate([{ op: "upsert", collection: "Lore", name: "Secret", fields: { leaf: "text" } }]);
    const leaf = (await store.read("Secret")).children![0].uid;
    const before = await store.snapshot();
    for (const handle of ["Lore", leaf]) await expect(store.mutate([{ op: "disclose", uid: handle, name: "Known", summary: "Approved" }])).rejects.toThrow("narrative entity");
    await expect(store.mutate([{ op: "disclose", uid: "Missing", name: "Known", summary: "Approved" }])).rejects.toThrow("Unknown");
    await expect(store.mutate([{ op: "disclose", uid: "Secret", name: " ", summary: "Approved" }])).rejects.toThrow("explicit player-safe name and summary");
    expect(await store.snapshot()).toBe(before);
  });
});

describe("atomic disclosed identity preservation", () => {
  let store: SqliteKnowledgeStore;
  beforeEach(() => { store = new SqliteKnowledgeStore(":memory:"); });
  afterEach(async () => { await store.close(); });
  const memories = async () => Promise.all((await store.outline()).filter(node => node.kind === "entity" && node.name.startsWith("Player memory:")).map(node => store.read(node.uid)));
  it("preserves the pre-batch name, aliases, prose and nested collection before earlier operations add secrets", async () => {
    await store.mutate([
      { op: "create_collection", parent: "Characters", name: "Visitors" },
      { op: "upsert", collection: "Characters/Visitors", name: "Pansy", aliases: ["Flower Seller"], body: "A cheerful florist.", visibility: "player-facing", fields: { firstScene: 1, lastScene: 2 } },
    ]);
    const uid = (await store.resolve("Pansy"))!;
    await store.mutate([
      { op: "patch", uid, name: "Lady Seraphine", aliases: ["Secret Queen"], body: "Secret ruler of the dead." },
      { op: "patch", uid, visibility: "private" },
    ], { sceneNumber: 3 });
    expect(await store.resolve("Secret Queen")).toBe(uid);
    expect((await store.read(uid)).visibility).toBe("private");
    const [memory] = await memories();
    expect(memory.fields).toMatchObject({ subject: { $ref: uid }, display_name: "Pansy", public_aliases: ["Flower Seller", "Pansy"], summary: "A cheerful florist.", firstScene: 1, lastScene: 2 });
    const outline = await store.outline();
    const parent = outline.find(node => node.uid === memory.parent)!;
    expect(parent.name).toBe("Visitors");
    expect(outline.find(node => node.uid === parent.parent)!.name).toBe("Characters");
    expect(outline.find(node => node.uid === outline.find(node => node.uid === parent.parent)!.parent)!.name).toBe("Player Knowledge");
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Pansy", body: "Even more secrets", visibility: "private" }]);
    expect(await memories()).toHaveLength(1);
    expect((await memories())[0].fields.summary).toBe("A cheerful florist.");
  });
  it("rolls preservation, aliases, notices and newly created collections back after a late failure", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Pansy", body: "Known florist", visibility: "player-facing" }]);
    const before = await store.snapshot();
    const notices = await store.pendingNotices();
    await expect(store.mutate([
      { op: "patch", uid: "Pansy", name: "Secret Queen", visibility: "private" },
      { op: "patch", uid: "Missing", body: "invalid" },
    ])).rejects.toThrow("Unknown knowledge identity");
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual(notices);
    expect(await store.resolve("Secret Queen")).toBeNull();
    expect(await memories()).toHaveLength(0);
  });
  it("does not trust a similarly named record for another subject or a summary outside Player Knowledge", async () => {
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "Pansy", body: "Known florist", visibility: "player-facing" },
      { op: "upsert", collection: "Characters", name: "Other" },
      { op: "create_collection", name: "Player Knowledge" },
      { op: "create_collection", parent: "Player Knowledge", name: "Characters" },
    ]);
    const uid = (await store.resolve("Pansy"))!;
    await store.mutate([
      { op: "upsert", collection: "Player Knowledge/Characters", name: `Player memory: ${uid}`, visibility: "player-facing", fields: { subject: { $ref: "Other" }, display_name: "Other", summary: "Unrelated approval" } },
      { op: "upsert", collection: "Lore", name: "Misplaced approval", visibility: "player-facing", fields: { subject: { $ref: uid }, display_name: "Wrong", summary: "Outside approved owner" } },
      { op: "patch", uid, visibility: "private" },
    ]);
    const records = await memories();
    expect(records).toHaveLength(2);
    expect(records.find(record => (record.fields.subject as { $ref: string }).$ref === uid)!.fields.summary).toBe("Known florist");
    expect(records.find(record => (record.fields.subject as { $ref: string }).$ref !== uid)!.fields.summary).toBe("Unrelated approval");
    expect(await store.resolve("Player memory: " + uid)).toBe(records.find(record => (record.fields.subject as { $ref: string }).$ref !== uid)!.uid);
  });
  it("does not preserve a newly introduced identity or recursively preserve an approved summary", async () => {
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "New", visibility: "player-facing", body: "Never disclosed before this batch" },
      { op: "patch", uid: "New", visibility: "private" },
      { op: "create_collection", name: "Player Knowledge" },
      { op: "upsert", collection: "Player Knowledge", name: "Approved New", visibility: "player-facing", fields: { subject: { $ref: "New" }, display_name: "New", summary: "Approved view" } },
    ]);
    await store.mutate([{ op: "patch", uid: "Approved New", visibility: "private" }]);
    expect(await memories()).toHaveLength(0);
  });
  it.each([false, true])("rejects mixed-visibility consolidation in either direction (%s) without leaking private content", async reverse => {
    await store.mutate([
      { op: "upsert", collection: "Characters", name: "Public", body: "Known", visibility: "player-facing" },
      { op: "upsert", collection: "Characters", name: "Secret", body: "Hidden" },
    ]);
    const before = await store.snapshot();
    await expect(store.mutate([{ op: "consolidate", uid: reverse ? "Public" : "Secret", target: reverse ? "Secret" : "Public" }])).rejects.toThrow("make both private first");
    expect(await store.snapshot()).toBe(before);
  });
});

describe("SQLite campaign recovery boundaries",()=>{
  let root:string;
  beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"mv-knowledge-"));});
  afterEach(async()=>{await rm(root,{recursive:true,force:true});});
  it("reopens a replaced snapshot including aliases, edges and pending notices",async()=>{
    const path=join(root,"knowledge.sqlite"); const store=new SqliteKnowledgeStore(path,{create:true});
    await store.mutate([{op:"upsert",collection:"Characters",name:"Bob",aliases:["Hat"]}]);
    const backup=join(root,"before.sqlite"); await store.withSnapshot(()=>copyFile(path,backup));
    await store.mutate([{op:"patch",uid:"Bob",name:"Robert"}]);
    await store.withSnapshot(()=>copyFile(backup,path));
    expect((await store.read("Hat")).name).toBe("Bob");
    expect(await store.resolve("Robert")).toBeNull();
    expect(await store.pendingNotices()).toHaveLength(1);
    await store.close();
  });
  it("resolves generated UIDs after they grow beyond the initial four-digit width", async () => {
    const path = join(root, "knowledge.sqlite");
    const initial = new SqliteKnowledgeStore(path, { create: true });
    await initial.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE metadata SET value=? WHERE key='next_uid'").run(String(36 ** 6));
    database.close();
    const store = new SqliteKnowledgeStore(path, { create: false });
    try {
      await store.mutate([{ op: "upsert", collection: "Characters", name: "Long-lived identity" }]);
      const uid = (await store.resolve("Long-lived identity"))!;
      expect(uid).toBe("k1000000");
      expect(await store.resolveUid(uid)).toBe(uid);
      expect(await store.resolveUid("Long-lived identity")).toBeNull();
    } finally { await store.close(); }
  });
  it("rejects missing/future databases without creating or modifying bytes",async()=>{
    const path=join(root,"missing.sqlite"); expect(()=>new SqliteKnowledgeStore(path,{create:false})).toThrow("missing");
    await expect(readFile(path)).rejects.toThrow();
    const future=join(root,"future.sqlite"); const db=new DatabaseSync(future);db.exec("PRAGMA user_version=999");db.close();const before=await readFile(future);
    expect(()=>new SqliteKnowledgeStore(future,{create:false})).toThrow("999");
    expect(await readFile(future)).toEqual(before);
  });
  it("does not recreate a source removed during capture, and read-only inspection preserves bytes",async()=>{
    const path=join(root,"knowledge.sqlite");const store=new SqliteKnowledgeStore(path,{create:true});await store.close();
    const before=await readFile(path);const inspector=new SqliteKnowledgeStore(path,{readOnly:true,create:false});await inspector.outline();await inspector.close();expect(await readFile(path)).toEqual(before);
    await store.withSnapshot(()=>rm(path));await expect(readFile(path)).rejects.toThrow();
    await expect(store.outline()).rejects.toThrow("missing");
  });
});


describe('engine supplied knowledge ownership', () => {
  it('protects concrete notes and mechanics while allowing arbitrary same-named facts', async () => {
    const store = new SqliteKnowledgeStore(':memory:');
    await store.mutate([{ op: 'create_collection', name: 'Spells' }, { op: 'upsert', collection: 'Lore', name: 'DM Notes', body: 'private plan' }, { op: 'upsert', collection: 'Characters', name: 'PC', fields: { hp: 7, biography: 'old' } }, { op: 'upsert', collection: 'Spells', name: 'Spell', fields: { hp: 3, stats: 'observed effects' } }]);
    const ownership = { protectedRoots: ['Lore/DM Notes'], protectedFields: { PC: ['hp'] }, source: 'co-dm' };
    await expect(store.mutate([{ op: 'patch', uid: 'DM Notes', body: 'overwritten' }], ownership)).rejects.toThrow('protected');
    await expect(store.mutate([{ op: 'patch', uid: 'PC', fields: { hp: 8 } }], ownership)).rejects.toThrow('engine-owned');
    const hp = (await store.read('PC')).children!.find(child => child.name === 'hp')!;
    await expect(store.mutate([{ op: 'set_value', uid: hp.uid, value: 8 }], ownership)).rejects.toThrow('protected');
    await expect(store.mutate([{ op: 'delete', uid: 'PC' }], ownership)).rejects.toThrow('owner');
    await store.mutate([{ op: 'patch', uid: 'PC', fields: { biography: 'new' } }, { op: 'patch', uid: 'Spell', fields: { hp: 9, stats: 'new observations' } }], ownership);
    expect((await store.read('PC')).fields).toMatchObject({ hp: 7, biography: 'new' });
    expect((await store.read('Spell')).fields.hp).toBe(9);
    store.close();
  });
  it('checks epoch inside serialized writes before any effect', async () => {
    const store = new SqliteKnowledgeStore(':memory:');
    await expect(store.mutate([{ op: 'upsert', collection: 'Lore', name: 'late' }], { assertCurrent: () => { throw new Error('abandoned'); } })).rejects.toThrow('abandoned');
    expect(await store.resolve('late')).toBeNull(); store.close();
  });
});
