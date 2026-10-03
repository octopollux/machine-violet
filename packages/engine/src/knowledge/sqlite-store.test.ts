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
