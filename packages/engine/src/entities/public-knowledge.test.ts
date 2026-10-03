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
  it("pages a full publicly visible PC sheet and navigates an old UID after consolidation", async () => {
    const store = makeStore(); const sheet = "Public inventory. ".repeat(1200);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Ada", visibility: "player-facing", body: sheet }, { op: "upsert", collection: "Characters", name: "A", body: "PRIVATE_SENTINEL" }]);
    const oldUid = await store.resolve("A");
    await store.mutate([{ op: "consolidate", uid: "A", target: "Ada" }]);
    // Consolidation appends source body by design, so this test makes the
    // approved body explicit again before checking the public endpoint.
    await store.mutate([{ op: "patch", uid: "Ada", body: sheet }]);
    expect((await readPublicCampaignRecord(store, oldUid ?? "missing"))?.content).toContain(sheet);
  });
});
