import { describe, it, expect, afterEach } from "vitest";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-store.js";
import { ENTITY_TOOLS, buildKnowledgeToolHandler } from "./tools.js";

const stores: SqliteKnowledgeStore[] = [];
const setup = () => { const store = new SqliteKnowledgeStore(":memory:"); stores.push(store); return { store, handler: buildKnowledgeToolHandler(store, { sceneNumber: 7 }) }; };
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe("generic campaign memory contracts", () => {
  it("keeps schemas stable while nested empty collections and typed data are created", async () => {
    const { store, handler } = setup();
    const definitions = JSON.stringify(ENTITY_TOOLS);
    const result = await handler("remember", { operations: [
      { op: "create_collection", name: "Spells", note: "Learned named spells and practitioners" },
      { op: "create_collection", parent: "Spells", name: "Arcane" },
      { op: "upsert", collection: "Spells/Arcane", name: "Firefly", fields: { level: 2, learned: true, notes: null, casts: [1, { potency: 0.5 }] } },
    ] });
    expect(result?.is_error).toBeUndefined();
    const node = await store.read("Firefly");
    expect(node.fields).toMatchObject({ level: 2, learned: true, notes: null, casts: [1, { potency: 0.5 }] });
    expect(JSON.stringify(ENTITY_TOOLS)).toBe(definitions);
    expect(JSON.stringify(ENTITY_TOOLS)).not.toContain('"enum":["character"');
    expect(JSON.parse((await handler("knowledge", { action: "outline" }))!.content)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Spells", kind: "collection", note: "Learned named spells and practitioners" })]));
  });

  it("rejects bad operations before writes, then accepts corrected input", async () => {
    const { store, handler } = setup();
    const before = await store.snapshot();
    const bad = await handler("remember", { operations: [{ op: "upsert", collection: "Characters" }] });
    expect(bad?.is_error).toBe(true);
    expect(bad?.content).toContain("name or uid");
    expect(await store.snapshot()).toBe(before);
    expect(await store.pendingNotices()).toEqual([]);
    const retry = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Bob" }] });
    expect(retry?.is_error).toBeUndefined();
    expect(JSON.parse(retry!.content).identities).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Bob", uid: expect.any(String) })]));
  });

  it("resolves aliases and same-name updates without a clarification result", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Tall Hat", aliases: ["Bob"], fields: { mood: "happy", hp: 8 } }] });
    const uid = await store.resolve("Tall Hat");
    const result = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "Bob", fields: { hp: 7 }, history: "Took one damage" }] });
    expect(result?.is_error).toBeUndefined();
    expect(await store.resolve("Bob")).toBe(uid);
    expect((await store.read(uid!)).fields).toMatchObject({ mood: "happy", hp: 7 });
    expect((await store.read(uid!)).logs).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Took one damage" })]));
  });

  it("preserves references during unrelated edits and returns committed impact candidates", async () => {
    const { store, handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Locations", name: "Castle" }, { op: "upsert", collection: "Characters", name: "Resident" }, { op: "add_reference", source: "Resident", target: "Castle", label: "lives there" }] });
    const result = await handler("remember", { operations: [{ op: "patch", uid: "Castle", fields: { burned: true }, history: "Burned" }] });
    expect(JSON.parse(result!.content).candidates).toContain(await store.resolve("Resident"));
    await handler("remember", { operations: [{ op: "patch", uid: "Resident", fields: { hp: 8 } }] });
    expect((await store.read("Resident")).references).toEqual(expect.arrayContaining([expect.objectContaining({ target: await store.resolve("Castle") })]));
    expect((await store.read("Resident")).fields).not.toHaveProperty("dead");
  });

  it("reads bulk text/history in bounded pages and searches typed scalar leaves", async () => {
    const { handler } = setup();
    await handler("remember", { operations: [{ op: "upsert", collection: "Lore", name: "Chronicle", body: "a".repeat(20000) + "needle", fields: { detail: "x".repeat(1000) + "leafneedle" }, history: "h".repeat(2000) }] });
    const first = JSON.parse((await handler("knowledge", { action: "read", handle: "Chronicle", textLimit: 12, logTextLimit: 13 }))!.content);
    expect(first.body).toHaveLength(12);
    expect(first.logs[0].body).toHaveLength(13);
    expect(first.textLength).toBe(20006);
    const hits = JSON.parse((await handler("knowledge", { action: "search", query: "leafneedle" }))!.content);
    expect(hits.length).toBeGreaterThan(0);
    const bad = await handler("knowledge", { action: "read", handle: "Chronicle", textOffset: -1 });
    expect(bad?.is_error).toBe(true);
  });
});
