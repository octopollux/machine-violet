import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import { parseChangelogEntries, planChangelogEntries } from "./changelog-updater.js";

describe("changelog mutation plans", () => {
  let store: SqliteKnowledgeStore;
  beforeEach(() => { store = new SqliteKnowledgeStore(":memory:"); });
  afterEach(async () => { await store.close(); });

  it("resolves aliases into stable UID operations without writing and replays exactly once", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Ada", aliases: ["Tall Hat"] }]);
    const uid = (await store.resolve("Ada"))!;
    const notices = await store.pendingNotices();
    const entries = parseChangelogEntries(`Tall Hat: Inspected the lock: it was broken.\n${uid}: Returned the key.\nUnknown: Not a campaign record.\nUnstructured prose\n${uid}: `);
    const operations = await planChangelogEntries(store, entries, 7);
    expect(operations).toEqual([
      { op: "append_log", uid, body: "Inspected the lock: it was broken.", metadata: { sceneNumber: 7 } },
      { op: "append_log", uid, body: "Returned the key.", metadata: { sceneNumber: 7 } },
    ]);
    expect((await store.read(uid)).logCount).toBe(0);
    expect(await store.pendingNotices()).toEqual(notices);
    const persisted = JSON.parse(JSON.stringify(operations)) as typeof operations;
    const options = { operationId: "scene-updates:transition-one", source: "scene-updates", sceneNumber: 7 };
    const committed = await store.mutate(persisted, options);
    await store.mutate([{ op: "patch", uid, name: "Captain Ada" }]);
    expect(await store.mutate(persisted, options)).toEqual(committed);
    const logs = (await store.read(uid)).logs;
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.metadata.sceneNumber)).toEqual([7, 7]);
    expect(logs[0].body).toBe("Inspected the lock: it was broken.");
  });

  it("keeps changed generated prose in a distinct plan instead of reusing a per-entity retry ID", async () => {
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Ada" }]);
    const first = await planChangelogEntries(store, ["Ada: Returned the key."], 7);
    const regenerated = await planChangelogEntries(store, ["Ada: Handed the key to Bela."], 7);
    expect(regenerated).not.toEqual(first);
    expect((await store.read("Ada")).logCount).toBe(0);
  });
});
