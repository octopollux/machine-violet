import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SqliteKnowledgeStore } from "../../../packages/engine/src/knowledge/sqlite-store.js";
import { inspectKnowledge, changedKnowledge, isKnowledgeFile } from "../src/server/knowledge-reader.js";
import express from "express";
import { createApiRouter } from "../src/server/api.js";

describe("offline logical knowledge inspection", () => {
  it("preserves typed/private data, arbitrary nesting and UID identity without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-knowledge-view-"));
    const file = join(root, "knowledge.sqlite");
    const store = new SqliteKnowledgeStore(file, { create: true });
    try {
      await writeFile(join(root, "config.json"), JSON.stringify({ version: 2 }));
      await store.mutate([{ op: "create_collection", name: "Rituals" }]);
      const collection = await store.resolve("Rituals");
      await store.mutate([{ op: "upsert", collection: collection!, name: "Lantern", fields: { secret: "DM only", yes: true, empty: null, number: 7, code: "007" } }]);
      const uid = (await store.resolve("Rituals/Lantern"))!;
      await store.mutate([{ op: "append_log", uid, body: "x".repeat(1500) }]);
      await store.close();
      const bytes = await readFile(file); const files = await readdir(root);
      const before = await inspectKnowledge(root);
      expect(before.entries.find((e) => e.uid === uid)?.displayName).toBe("Rituals/Lantern");
      expect(before.nodes.get(uid)?.fields).toMatchObject({ secret: "DM only", yes: true, empty: null, number: 7, code: "007" });
      expect(before.nodes.get(uid)?.logs[0].body).toHaveLength(1500);
      expect(await readFile(file)).toEqual(bytes); expect(await readdir(root)).toEqual(files);
      await store.mutate([{ op: "patch", uid, name: "Renamed" }]);
      await store.close();
      const after = await inspectKnowledge(root);
      expect(after.entries.find((e) => e.uid === uid)?.relativePath).toBe(`knowledge/${uid}.json`);
      expect(changedKnowledge(before.fingerprints, after.fingerprints)).toContain(uid);
      await store.mutate([{ op: "delete", uid }]); await store.close();
      expect(changedKnowledge(after.fingerprints, (await inspectKnowledge(root)).fingerprints)).toContain(uid);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("fails missing database without creating it and blocks raw database sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-knowledge-missing-"));
    try {
      await writeFile(join(root, "config.json"), JSON.stringify({ version: 2 }));
      await expect(inspectKnowledge(root)).rejects.toThrow();
      expect(await readdir(root)).toEqual(["config.json"]);
      for (const file of ["knowledge.sqlite", "knowledge.sqlite-wal", "knowledge.sqlite-shm", "knowledge.sqlite-journal"]) expect(isKnowledgeFile(file)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("serves logical UID JSON while rejecting physical DB and sidecar requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-knowledge-api-"));
    const store = new SqliteKnowledgeStore(join(root, "knowledge.sqlite"), { create: true });
    const app = express();
    app.use("/api", createApiRouter(() => [{ slug: "fixture", name: "Fixture", path: root }], () => root));
    const listener = app.listen(0, "127.0.0.1");
    try {
      await writeFile(join(root, "config.json"), JSON.stringify({ version: 2 }));
      await store.mutate([{ op: "create_collection", name: "Arcane" }]);
      const collection = (await store.resolve("Arcane"))!;
      await store.mutate([{ op: "upsert", collection, name: "Secret", body: "Private developer view" }]);
      const uid = (await store.resolve("Arcane/Secret"))!;
      await store.close();
      if (!listener.listening) await new Promise<void>((resolve) => listener.once("listening", resolve));
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No fixture listener");
      const base = `http://127.0.0.1:${address.port}/api/campaigns/fixture`;
      const tree = await (await fetch(`${base}/tree`)).json() as { uid?: string; relativePath: string }[];
      expect(tree.some((entry) => entry.relativePath === "knowledge.sqlite")).toBe(false);
      expect(tree.some((entry) => entry.uid === uid)).toBe(true);
      expect(await (await fetch(`${base}/file/knowledge/${uid}.json`)).json()).toMatchObject({ uid, body: "Private developer view" });
      for (const suffix of ["", "-wal", "-shm", "-journal"]) expect((await fetch(`${base}/file/knowledge.sqlite${suffix}`)).status).toBe(403);
      expect((await fetch(`${base}/file/knowledge/kzzz.json`)).status).toBe(404);
    } finally { await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
