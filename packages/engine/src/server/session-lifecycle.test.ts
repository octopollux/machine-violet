import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SetupSession } from "./setup-session.js";
import { createBaseFileIO } from "./fileio.js";
import { getCampaignKnowledge } from "../knowledge/store.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { LLMProvider } from "../providers/types.js";
import { createDefaultCampaignConfig } from "../tools/filesystem/config.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "mv-session-close-")); roots.push(temporary);
  const campaigns = join(temporary, "campaigns"); const root = join(campaigns, "test");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify(createDefaultCampaignConfig("Test", "Player", "Hero")));
  const io = createBaseFileIO(); const store = await getCampaignKnowledge(root, io, { create: true });
  await store.mutate([{ op: "upsert", collection: "Characters", name: "Hero" }]);
  const manager = new SessionManager(campaigns);
  const internal = manager as unknown as { ownedFileIO: FileIO | null; engine: GameEngine | null; status: string; campaignId: string | null; sessionProviders: Set<LLMProvider>; doStartSession(id: string): Promise<void> };
  return { root, io, store, manager, internal };
}
function engine(methods?: Record<string, unknown>): GameEngine {
  return { beginTeardown: vi.fn(), settleDeferredWork: vi.fn(async () => undefined), getPersister: () => ({ flush: vi.fn(async () => undefined) }), getRepo: () => null, ...methods } as unknown as GameEngine;
}

describe("session-owned SQLite lifecycle", () => {
  it("closes on failed startup, preserves the failure, and allows a fresh start with a fresh owner", async () => {
    const { root, io, store, manager, internal } = await fixture();
    const start = vi.spyOn(internal, "doStartSession").mockImplementationOnce(async () => {
      internal.ownedFileIO = io; internal.engine = engine(); throw new Error("startup failed after database open");
    });
    await expect(manager.startSession("test")).rejects.toThrow("startup failed");
    expect(manager.isBusy).toBe(false);
    expect(manager.getEngine()).toBeNull();
    await expect(store.read("Hero")).rejects.toThrow("disposed");
    const fresh = createBaseFileIO();
    start.mockImplementationOnce(async () => { internal.ownedFileIO = fresh; await getCampaignKnowledge(root, fresh); internal.status = "active"; });
    await manager.startSession("test");
    expect(manager.isActive).toBe(true);
    await manager.endSession();
    await rm(root, { recursive: true });
  });

  it("preserves a healthy deferred write then closes even when flush rejects, before engine state is cleared", async () => {
    const { root, io, store, manager, internal } = await fixture();
    const order: string[] = [];
    const flush = vi.fn(async () => { order.push("flush"); throw new Error("failed final flush"); });
    internal.engine = engine({ settleDeferredWork: vi.fn(async () => { order.push("deferred"); await store.mutate([{ op: "patch", uid: "Hero", body: "Committed quit write" }]); }), getPersister: () => ({ flush }) });
    const ownerClose = io.closeKnowledgeStores;
    io.closeKnowledgeStores = async () => { expect(manager.getEngine()).not.toBeNull(); order.push("close"); await ownerClose?.(); };
    internal.ownedFileIO = io; internal.status = "active"; internal.campaignId = "test";
    await manager.endSession();
    expect(order.at(-1)).toBe("close");
    expect(order[0]).toBe("deferred");
    expect(manager.isBusy).toBe(false);
    const fresh = createBaseFileIO();
    expect((await (await getCampaignKnowledge(root, fresh)).read("Hero")).body).toBe("Committed quit write");
    await fresh.closeKnowledgeStores?.(); await rm(root, { recursive: true });
  });

  it("bounds stalled deferred work and provider disposal, seals held handles, and permits immediate deletion", async () => {
    const { root, io, store, manager, internal } = await fixture();
    vi.useFakeTimers();
    internal.engine = engine({ settleDeferredWork: vi.fn(() => new Promise(() => undefined)) });
    internal.ownedFileIO = io; internal.status = "active";
    internal.sessionProviders.add({ providerId: "stalled", dispose: () => new Promise(() => undefined) } as unknown as LLMProvider);
    const ending = manager.endSession();
    await vi.advanceTimersByTimeAsync(40_000);
    await ending;
    expect(manager.isBusy).toBe(false);
    await expect(store.read("Hero")).rejects.toThrow("disposed");
    vi.useRealTimers(); await rm(root, { recursive: true });
  });

  it("does not wait forever for a checkpoint capture that already released its SQLite handle", async () => {
    const { root, io, store, manager, internal } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    internal.engine = engine({ getRepo: () => ({ checkpoint: () => store.withSnapshot(() => gate) }) });
    internal.ownedFileIO = io; internal.status = "active";
    vi.useFakeTimers();
    const ending = manager.endSession();
    await vi.advanceTimersByTimeAsync(20_000);
    await ending;
    expect(manager.isBusy).toBe(false);
    vi.useRealTimers(); await rm(root, { recursive: true }); release();
    await expect(store.read("Hero")).rejects.toThrow("disposed");
  });

  it("setup disposal waits its tracked finalized writes, releases its own store and rejects later input", async () => {
    const { root, io, store } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = Object.create(SetupSession.prototype) as SetupSession;
    Object.assign(setup, { fileIO: io, providersByConnectionId: new Map(), activeWork: new Set(), disposing: false,
      doSend: async () => { await gate; await store.mutate([{ op: "patch", uid: "Hero", body: "Setup completed" }]); return { finalized: "test" }; } });
    const sending = setup.send("Finalize");
    let closed = false;
    const disposed = setup.dispose().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); expect(await sending).toEqual({ finalized: "test" }); await disposed;
    await expect(setup.send("Too late")).rejects.toThrow("disposed");
    const fresh = createBaseFileIO();
    expect((await (await getCampaignKnowledge(root, fresh)).read("Hero")).body).toBe("Setup completed");
    await fresh.closeKnowledgeStores?.(); await rm(root, { recursive: true });
  });
});
