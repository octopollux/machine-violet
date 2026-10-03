import { describe, it, expect, afterEach } from "vitest";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-store.js";
import { projectCampaignCompendium, readPublicCampaignRecord } from "./public-knowledge.js";
import { commitPublicCompendium, emptyCompendium } from "../agents/subagents/compendium-updater.js";
const stores: SqliteKnowledgeStore[] = [];
const makeStore = () => { const store = new SqliteKnowledgeStore(":memory:"); stores.push(store); return store; };
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe("approved campaign knowledge", () => {
  it("creates nested public records and cross-links atomically without changing private source collections", async () => {
    const store = makeStore(); const publicMemory = emptyCompendium();
    publicMemory.collections = { "Spells/Arcane": [
      { name: "Firefly", slug: "firefly", summary: "A light spell. ".repeat(1500), aliases: Array.from({ length: 40 }, (_, i) => `Light ${i}`), firstScene: 1, lastScene: 1, related: ["Beacon"] },
      { name: "Beacon", slug: "beacon", summary: "A distant light.", firstScene: 1, lastScene: 1, related: [] },
    ] };
    const projected = await commitPublicCompendium(store, publicMemory, 1);
    const spell = await store.read("Firefly"); const beacon = await store.resolve("Beacon");
    expect(projected.collections?.["Spells/Arcane"][0]).toMatchObject({ uid: spell.uid, summary: publicMemory.collections["Spells/Arcane"][0].summary, related: [beacon] });
    expect(projected.collections?.["Spells/Arcane"][0].aliases).toHaveLength(40);
    expect(await store.resolve("Spells/Arcane")).not.toBe(await store.resolve("Player Knowledge/Spells/Arcane"));
    expect(spell.visibility).toBe("private");
    expect((await readPublicCampaignRecord(store, "Light 39"))?.uid).toBe(spell.uid);
  });
  it("never follows private bodies, fields, dependency labels, or forged preview markers", async () => {
    const store = makeStore();
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Hidden Bob", fields: { secret: "PRIVATE_SENTINEL_".repeat(100) }, body: "PRIVATE_SENTINEL_body" }]);
    const bob = await store.resolve("Hidden Bob");
    const leaf = (await store.outline()).find((entry) => entry.parent === bob && entry.name === "secret");
    expect(leaf).toBeDefined();
    // Internal markers may be rejected at the authoring boundary; if ordinary
    // descriptor-shaped data is accepted, the projector still verifies ancestry.
    try { await store.mutate([{ op: "upsert", collection: "Lore", name: "Approved", visibility: "player-facing", fields: { subject: { $ref: "Hidden Bob" }, display_name: "Bob", summary: { $text: leaf?.uid ?? "missing", length: 1000 } } }]); } catch { /* atomic reserved-marker rejection */ }
    expect(JSON.stringify(await projectCampaignCompendium(store))).not.toContain("PRIVATE_SENTINEL");
    expect(await readPublicCampaignRecord(store, "Hidden Bob")).toBeNull();
  });

  it("discloses safe facts immediately from a private canonical identity in an arbitrary nested collection", async () => {
    const store = makeStore();
    await store.mutate([
      { op: "create_collection", name: "player knowledge" },
      { op: "create_collection", name: "Echoes" },
      { op: "create_collection", parent: "Echoes", name: "Archivists" },
      { op: "upsert", collection: "Echoes/Archivists", name: "Zhijun Nabo", aliases: ["King"], body: "PRIVATE_SENTINEL", fields: { secret: "PRIVATE_SENTINEL" } },
    ]);
    const uid = await store.resolve("Zhijun Nabo"); const canonical = await store.read(uid ?? "missing");
    await store.mutate([{ op: "disclose", uid: uid ?? "missing", name: "The Junior Archivist", summary: "An echo in the prism confirmed the receipt's missing name belonged to them.", aliases: ["Archivist Echo"] }], { sceneNumber: 3, source: "scribe" });
    expect(await store.read(uid ?? "missing")).toEqual(canonical);
    for (const handle of [uid ?? "missing", "The Junior Archivist", "Archivist Echo"]) {
      expect(await readPublicCampaignRecord(store, handle)).toMatchObject({ uid, name: "The Junior Archivist", collection: "Echoes/Archivists" });
    }
    expect(await readPublicCampaignRecord(store, "Zhijun Nabo")).toBeNull();
    expect(await readPublicCampaignRecord(store, "King")).toBeNull();
    expect(JSON.stringify(await projectCampaignCompendium(store))).not.toContain("PRIVATE_SENTINEL");
    const summary = "The echo publicly identified themself as Zhijun Nabo. ".repeat(450);
    await store.mutate([{ op: "disclose", uid: "King", name: "Zhijun Nabo", summary }], { sceneNumber: 4 });
    for (const handle of ["The Junior Archivist", "Archivist Echo", "Zhijun Nabo"]) {
      expect((await readPublicCampaignRecord(store, handle))?.content).toBe(`# Zhijun Nabo\n\n${summary}`);
    }
    expect((await store.read(uid ?? "missing")).visibility).toBe("private");
    expect(await readPublicCampaignRecord(store, "King")).toBeNull();
  });
  it("preserves one privately revealed identity and its approved public view through hidden-name updates", async () => {
    const store = makeStore(); const publicBody = "Bellwether's practical village sexton.";
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Pansy Jackh", aliases: ["Pansy"], visibility: "player-facing", body: publicBody }]);
    const uid = await store.resolve("Pansy");
    await store.mutate([{ op: "patch", uid: uid ?? "missing", name: "Lady Seraphine Vale", visibility: "private", body: `${publicBody} PRIVATE_SENTINEL: secretly negotiating with the duke.`, fields: { hidden_plan: "PRIVATE_SENTINEL" } }], { sceneNumber: 4, source: "scribe" });
    expect(await store.resolve("Lady Seraphine Vale")).toBe(uid);
    expect((await store.read(uid ?? "missing")).visibility).toBe("private");
    expect(await readPublicCampaignRecord(store, "Pansy")).toMatchObject({ uid, name: "Pansy Jackh", content: `# Pansy Jackh\n\n${publicBody}` });
    expect((await readPublicCampaignRecord(store, uid ?? "missing"))?.name).toBe("Pansy Jackh");
    expect(await readPublicCampaignRecord(store, "Lady Seraphine Vale")).toBeNull();
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Lady Seraphine Vale", fields: { private_report: "PRIVATE_SENTINEL: met the duke" } }]);
    const characters = await store.resolve("Characters");
    expect((await store.outline()).filter((entry) => entry.kind === "entity" && entry.parent === characters)).toHaveLength(1);
    expect(JSON.stringify(await projectCampaignCompendium(store))).not.toContain("PRIVATE_SENTINEL");
    const approved = emptyCompendium();
    approved.collections = { Characters: [{ uid: uid ?? "missing", name: "Lady Seraphine Vale", slug: uid ?? "missing", aliases: ["Pansy", "Pansy Jackh"], summary: "Pansy is Lady Seraphine Vale; her identity is now known.", firstScene: 1, lastScene: 5, related: [] }] };
    await commitPublicCompendium(store, approved, 5);
    expect((await readPublicCampaignRecord(store, "Lady Seraphine Vale"))?.uid).toBe(uid);
    expect((await store.read(uid ?? "missing")).visibility).toBe("private");
    expect(JSON.stringify(await projectCampaignCompendium(store))).not.toContain("PRIVATE_SENTINEL");
  });
  it("keeps an existing approved summary when a canonical identity becomes private", async () => {
    const store = makeStore();
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Tall Hat", visibility: "player-facing", body: "A tall mysterious figure wearing a hat." }]);
    const uid = await store.resolve("Tall Hat"); const approved = emptyCompendium();
    approved.collections = { Characters: [{ uid: uid ?? "missing", name: "The Stranger", slug: uid ?? "missing", summary: "The stranger has offered help.", aliases: ["Tall Hat"], firstScene: 2, lastScene: 2, related: [] }] };
    await commitPublicCompendium(store, approved, 2);
    await store.mutate([{ op: "patch", uid: "Tall Hat", name: "Bob", visibility: "private", fields: { secret: "PRIVATE_SENTINEL" } }], { sceneNumber: 3 });
    expect((await readPublicCampaignRecord(store, uid ?? "missing"))?.content).toBe("# The Stranger\n\nThe stranger has offered help.");
    expect(await readPublicCampaignRecord(store, "Bob")).toBeNull();
  });
  it("retains both approved public identities after private canonical consolidation", async () => {
    const store = makeStore();
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Pansy", aliases: ["The Sexton"], visibility: "player-facing", body: "A village sexton." }, { op: "upsert", collection: "Characters", name: "Tall Hat", aliases: ["The Stranger"], visibility: "player-facing", body: "A helpful stranger." }]);
    const oldUid = await store.resolve("Pansy"); const targetUid = await store.resolve("Tall Hat");
    await store.mutate([{ op: "patch", uid: "Pansy", name: "Lady Seraphine", aliases: ["King"], visibility: "private", body: "PRIVATE_SENTINEL_one" }, { op: "patch", uid: "Tall Hat", name: "Secret Archivist", aliases: ["Knight"], visibility: "private", body: "PRIVATE_SENTINEL_two" }]);
    await store.mutate([{ op: "consolidate", uid: oldUid ?? "missing", target: targetUid ?? "missing" }]);
    for (const handle of ["Pansy", "The Sexton", "Tall Hat", "The Stranger", oldUid ?? "missing", targetUid ?? "missing"]) {
      expect((await readPublicCampaignRecord(store, handle))?.uid).toBe(targetUid);
    }
    expect(await readPublicCampaignRecord(store, "Lady Seraphine")).toBeNull();
    expect(await readPublicCampaignRecord(store, "Secret Archivist")).toBeNull();
    // Hidden names that happen to spell a possible UID must not resolve via
    // private aliases. Real canonical and historical UID handles still work.
    expect(await store.resolve("King")).toBe(targetUid);
    expect(await store.resolve("Knight")).toBe(targetUid);
    for (const handle of ["King", "Knight", "@King", "knowledge:Knight"]) {
      expect(await readPublicCampaignRecord(store, handle)).toBeNull();
    }
    const projection = await projectCampaignCompendium(store);
    expect(projection.collections?.Characters).toHaveLength(1);
    expect(JSON.stringify(projection)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(projection)).not.toContain("Lady Seraphine");
    await store.mutate([{ op: "disclose", uid: targetUid ?? "missing", name: "The Known Archivist", summary: "The two public identities belong to one archivist." }]);
    for (const handle of ["Pansy", "The Sexton", "Tall Hat", "The Stranger", oldUid ?? "missing", targetUid ?? "missing"]) {
      expect(await readPublicCampaignRecord(store, handle)).toMatchObject({ uid: targetUid, name: "The Known Archivist", content: "# The Known Archivist\n\nThe two public identities belong to one archivist." });
    }
    expect(await readPublicCampaignRecord(store, "King")).toBeNull();
    expect(await readPublicCampaignRecord(store, "Knight")).toBeNull();
  });

  it("pages a full publicly visible PC sheet and navigates an old public UID after consolidation", async () => {
    const store = makeStore(); const sheet = "Public inventory. ".repeat(1200);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Ada", visibility: "player-facing", body: sheet }, { op: "upsert", collection: "Characters", name: "A", visibility: "player-facing", body: "Known alias" }]);
    const oldUid = await store.resolve("A");
    await store.mutate([{ op: "consolidate", uid: "A", target: "Ada" }]);
    await store.mutate([{ op: "patch", uid: "Ada", body: sheet }]);
    expect((await readPublicCampaignRecord(store, oldUid ?? "missing"))?.content).toContain(sheet);
  });

});
