import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBaseFileIO } from "./fileio.js";
import { getCampaignKnowledge } from "../knowledge/store.js";
import { sandboxFileIO } from "../tools/filesystem/sandbox.js";
import { createDefaultCampaignConfig } from "../tools/filesystem/config.js";
import { archiveCampaign, createArchiveFileIO, deleteCampaign, unarchiveCampaign } from "../config/campaign-archive.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "mv-owner-close-")); roots.push(temporary);
  const campaigns = join(temporary, "campaigns");
  const root = join(campaigns, "test"); await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify(createDefaultCampaignConfig("Test", "Player", "Hero")));
  const io = createBaseFileIO();
  const store = await getCampaignKnowledge(root, io, { create: true });
  return { temporary, campaigns, root, io, store };
}

describe("owning FileIO SQLite teardown", () => {
  it("drains already queued writes, forwards closure through sandbox, rejects stale handles and permits immediate archive/restore/delete", async () => {
    const { root, campaigns, io, store } = await fixture();
    const secondRoot = join(campaigns, "second"); await mkdir(secondRoot);
    const second = await getCampaignKnowledge(secondRoot, io, { create: true });
    const sandbox = sandboxFileIO(io, [campaigns]);
    const firstWrite = store.mutate([{ op: "upsert", collection: "Characters", name: "Hero", aliases: ["Tall Hat"], body: "Persisted before quit" }]);
    const secondWrite = second.mutate([{ op: "upsert", collection: "Lore", name: "Other" }]);
    if (!sandbox.closeKnowledgeStores) throw new Error("Missing forwarded teardown");
    const closed = sandbox.closeKnowledgeStores();
    await expect(store.read("Hero")).rejects.toThrow("disposed");
    await Promise.all([firstWrite, secondWrite, closed]);
    await sandbox.closeKnowledgeStores();
    await expect(getCampaignKnowledge(root, sandbox)).rejects.toThrow("closed");
    // Windows requires the second database's handle to be released for this rm.
    await rm(secondRoot, { recursive: true });
    const archiveIO = createArchiveFileIO();
    const archived = await archiveCampaign(root, campaigns, archiveIO);
    expect(archived.ok).toBe(true);
    if (!archived.zipPath) throw new Error("Missing archive");
    const restored = await unarchiveCampaign(archived.zipPath, campaigns, archiveIO);
    expect(restored.ok).toBe(true);
    if (!restored.zipPath) throw new Error("Missing restored campaign");
    const reopenedIO = createBaseFileIO();
    const reopened = await getCampaignKnowledge(restored.zipPath, reopenedIO);
    expect((await reopened.read("Tall Hat")).body).toBe("Persisted before quit");
    await reopenedIO.closeKnowledgeStores?.();
    expect((await deleteCampaign(restored.zipPath, archiveIO)).ok).toBe(true);
  });

  it("releases an already closed snapshot handle without waiting for a stalled callback and never reopens it later", async () => {
    const { root, io, store } = await fixture();
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Hero" }]);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const snapshot = store.withSnapshot(async () => { started(); await gate; return "captured"; });
    await entered;
    const queuedWrite = store.mutate([{ op: "patch", uid: "Hero", body: "Must not resurrect deleted campaign" }]);
    const caughtWrite = queuedWrite.catch(error => error as Error);
    await io.closeKnowledgeStores?.();
    await rm(root, { recursive: true });
    release();
    expect(await snapshot).toBe("captured");
    expect((await caughtWrite).message).toContain("disposed");
    await expect(readFile(join(root, "knowledge.sqlite"))).rejects.toThrow();
  });

  it("drains ordinary writes but cancels a prequeued snapshot before its callback can hang disposal", async () => {
    const { root, io, store } = await fixture();
    const write = store.mutate([{ op: "upsert", collection: "Characters", name: "Hero" }]);
    let entered = false;
    const snapshot = store.withSnapshot(async () => { entered = true; await new Promise(() => undefined); });
    const checked = snapshot.catch(error => error as Error);
    await io.closeKnowledgeStores?.();
    await write;
    expect((await checked).message).toContain("disposed");
    expect(entered).toBe(false);
    const fresh = createBaseFileIO();
    expect(await (await getCampaignKnowledge(root, fresh)).resolve("Hero")).toEqual(expect.any(String));
    await fresh.closeKnowledgeStores?.();
    await rm(root, { recursive: true });
  });
});
