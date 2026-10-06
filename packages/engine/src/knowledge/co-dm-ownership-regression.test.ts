import { SqliteKnowledgeStore } from "./sqlite-store.js";

describe("co-DM reserved ownership across arbitrary tree changes", () => {
  it("cannot remove notes protection by renaming their ancestor before a later mutation", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    await store.mutate([{ op: "upsert", collection: "Lore", name: "DM Notes", body: "Unrevealed foreground plan.", visibility: "private" }]);
    const lore = await store.resolve("Lore");
    const notes = await store.resolve("Lore/DM Notes");
    if (!lore || !notes) throw new Error("Fixture identities were not created");
    const ownership = { source: "co-dm", protectedRoots: ["Lore/DM Notes"] };
    await expect(store.mutate([{ op: "patch", uid: lore, name: "Renamed Lore" }], ownership)).rejects.toThrow(/protected|owned/);
    await expect(store.mutate([{ op: "patch", uid: notes, body: "Overwritten plan." }], ownership)).rejects.toThrow(/protected|owned/);
    expect((await store.read(notes)).body).toBe("Unrevealed foreground plan.");
  });

  it("allows unrelated taxonomy maintenance while preserving reserved descendants", async () => {
    const store = new SqliteKnowledgeStore(":memory:");
    await store.mutate([
      { op: "create_collection", name: "Spells" },
      { op: "create_collection", parent: "Spells", name: "Arcane" },
      { op: "upsert", collection: "Lore", name: "DM Notes", body: "Private plan.", visibility: "private" },
      { op: "upsert", collection: "Spells/Arcane", name: "Prism reading", body: "Restores faded writing." },
    ]);
    const prism = await store.resolve("Prism reading");
    if (!prism) throw new Error("Fixture spell was not created");
    await store.mutate([{ op: "patch", uid: prism, fields: { observed: true }, history: "A prism restored faded writing." }], { source: "co-dm", protectedRoots: ["Lore/DM Notes"] });
    expect((await store.read(prism)).fields.observed).toBe(true);
    expect((await store.read(prism)).body).toBe("Restores faded writing.");
  });
});
