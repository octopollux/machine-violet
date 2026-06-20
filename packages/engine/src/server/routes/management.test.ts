import Fastify, { type FastifyInstance } from "fastify";
import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";
import { norm } from "../../utils/paths.js";

// The archive route's concurrency guard is the unit under test: a second
// archive of the SAME campaign while the first is in flight must be rejected
// (409), not run concurrently — two overlapping archives race the same zip
// path and source deletion, corrupting the archive ("contents mismatch on
// disk"). archiveCampaign itself is covered in campaign-archive.test.ts, so we
// replace it with a controllable deferred to make the overlap deterministic.
interface ArchiveResult { ok: boolean; zipPath?: string; error?: string }

// Created via vi.hoisted so they exist before vi.mock's factory (hoisted to the
// top of the module) references them. Both archive and restore are replaced with
// controllable deferreds so a concurrent overlap is deterministic.
const { archiveCampaignMock, pending, unarchiveCampaignMock, pendingRestore } = vi.hoisted(() => {
  const pending: ((v: ArchiveResult) => void)[] = [];
  const archiveCampaignMock = vi.fn(() => new Promise<ArchiveResult>((res) => { pending.push(res); }));
  const pendingRestore: ((v: ArchiveResult) => void)[] = [];
  const unarchiveCampaignMock = vi.fn(() => new Promise<ArchiveResult>((res) => { pendingRestore.push(res); }));
  return { archiveCampaignMock, pending, unarchiveCampaignMock, pendingRestore };
});

// Keep the real module (the route relies on the real `archiveDir` for path
// resolution, and `createArchiveFileIO` re-exported via ../fileio.js); override
// only the two long-running ops with controllable deferreds.
vi.mock("../../config/campaign-archive.js", async (importActual) => {
  const actual = await importActual<typeof import("../../config/campaign-archive.js")>();
  return {
    ...actual,
    archiveCampaign: archiveCampaignMock,
    unarchiveCampaign: unarchiveCampaignMock,
  };
});

import { managementRoutes } from "./management.js";

// In-process Fastify inject (no network) but boot can blow the 5s default
// under heavy parallel-suite CPU contention — give headroom (see dev.test.ts).
vi.setConfig({ testTimeout: 30_000 });

const ARCHIVE_URL = "/campaigns/test-campaign/archive";

async function buildApp(opts: { isBusy?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("configDir", "/tmp/config");
  app.decorate("sessionManager", {
    isBusy: opts.isBusy ?? false,
    getCampaignsDir: () => "/tmp/campaigns",
  } as never);
  await app.register(managementRoutes);
  await app.ready();
  return app;
}

describe("POST /campaigns/:id/archive — concurrency guard", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    archiveCampaignMock.mockClear();
    pending.length = 0;
  });

  afterEach(async () => {
    await app?.close();
  });

  it("rejects a second concurrent archive of the same campaign with 409", async () => {
    app = await buildApp();

    // Fire archive A but don't await — its handler takes the lock and parks on
    // the deferred archiveCampaign.
    const a = app.inject({ method: "POST", url: ARCHIVE_URL });
    // Ensure A is actually in flight (lock held) before firing B.
    await vi.waitFor(() => expect(archiveCampaignMock).toHaveBeenCalledTimes(1));

    // B overlaps A → rejected by the lock, never reaches archiveCampaign.
    const b = await app.inject({ method: "POST", url: ARCHIVE_URL });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatch(/already in progress/i);
    expect(archiveCampaignMock).toHaveBeenCalledTimes(1);

    // Let A finish.
    pending[0]({ ok: true, zipPath: "/tmp/campaigns/../archivedcampaigns/Test.zip" });
    const aRes = await a;
    expect(aRes.statusCode).toBe(200);
    expect(aRes.json()).toMatchObject({ ok: true });
  });

  it("releases the lock so a later archive of the same campaign succeeds", async () => {
    app = await buildApp();

    const a = app.inject({ method: "POST", url: ARCHIVE_URL });
    await vi.waitFor(() => expect(archiveCampaignMock).toHaveBeenCalledTimes(1));
    pending[0]({ ok: true, zipPath: "/x.zip" });
    expect((await a).statusCode).toBe(200);

    // Same id again, sequentially — the lock must have been released.
    const c = app.inject({ method: "POST", url: ARCHIVE_URL });
    await vi.waitFor(() => expect(archiveCampaignMock).toHaveBeenCalledTimes(2));
    pending[1]({ ok: true, zipPath: "/y.zip" });
    expect((await c).statusCode).toBe(200);
  });

  it("releases the lock even when the archive fails", async () => {
    app = await buildApp();

    const a = app.inject({ method: "POST", url: ARCHIVE_URL });
    await vi.waitFor(() => expect(archiveCampaignMock).toHaveBeenCalledTimes(1));
    pending[0]({ ok: false, error: "Failed to create zip archive" });
    expect((await a).statusCode).toBe(500);

    // A retry isn't wedged behind a stuck lock.
    const c = app.inject({ method: "POST", url: ARCHIVE_URL });
    await vi.waitFor(() => expect(archiveCampaignMock).toHaveBeenCalledTimes(2));
    pending[1]({ ok: true, zipPath: "/y.zip" });
    expect((await c).statusCode).toBe(200);
  });

  it("rejects archiving while a session is active before taking the lock", async () => {
    app = await buildApp({ isBusy: true });

    const res = await app.inject({ method: "POST", url: ARCHIVE_URL });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/session is active/i);
    expect(archiveCampaignMock).not.toHaveBeenCalled();
  });
});

describe("POST /campaigns/archived/:name/restore — concurrency guard", () => {
  let app: FastifyInstance;

  const restoreReq = (zipPath: string) => ({
    method: "POST" as const,
    url: "/campaigns/archived/Test/restore",
    payload: { zipPath },
  });

  beforeEach(() => {
    unarchiveCampaignMock.mockClear();
    pendingRestore.length = 0;
  });

  afterEach(async () => {
    await app?.close();
  });

  it("rejects a second concurrent restore of the same archive with 409", async () => {
    app = await buildApp();

    const a = app.inject(restoreReq("/arch/Test.zip"));
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(1));

    const b = await app.inject(restoreReq("/arch/Test.zip"));
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatch(/already in progress/i);
    expect(unarchiveCampaignMock).toHaveBeenCalledTimes(1);

    pendingRestore[0]({ ok: true });
    expect((await a).statusCode).toBe(200);
  });

  it("locks per archive — a different zip restores concurrently", async () => {
    app = await buildApp();

    const a = app.inject(restoreReq("/arch/One.zip"));
    const b = app.inject(restoreReq("/arch/Two.zip"));
    // Distinct zip paths → both pass the guard and run in parallel.
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(2));
    pendingRestore[0]({ ok: true });
    pendingRestore[1]({ ok: true });
    expect((await a).statusCode).toBe(200);
    expect((await b).statusCode).toBe(200);
  });

  it("releases the lock so the same archive can be restored again", async () => {
    app = await buildApp();

    const a = app.inject(restoreReq("/arch/Test.zip"));
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(1));
    pendingRestore[0]({ ok: true });
    expect((await a).statusCode).toBe(200);

    const c = app.inject(restoreReq("/arch/Test.zip"));
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(2));
    pendingRestore[1]({ ok: true });
    expect((await c).statusCode).toBe(200);
  });

  // campaignsDir is "/tmp/campaigns" → archives live in the SIBLING
  // "/tmp/archivedcampaigns", never the child "/tmp/campaigns/archivedcampaigns".
  const firstZipArg = () => norm(unarchiveCampaignMock.mock.calls[0][0] as string);

  it("restore-by-name resolves into the sibling archive dir, not a child", async () => {
    app = await buildApp();

    // No zipPath in the body → reconstruct from the :name param.
    const a = app.inject({ method: "POST", url: "/campaigns/archived/Test/restore", payload: {} });
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(1));
    expect(firstZipArg()).toBe(norm("/tmp/archivedcampaigns/Test.zip"));
    // The old bug pointed at the child dir.
    expect(firstZipArg()).not.toContain("campaigns/archivedcampaigns");
    pendingRestore[0]({ ok: true });
    expect((await a).statusCode).toBe(200);
  });

  it("confines an out-of-dir zipPath to the archive dir (no arbitrary read)", async () => {
    app = await buildApp();

    const a = app.inject(restoreReq("/etc/evil.zip"));
    await vi.waitFor(() => expect(unarchiveCampaignMock).toHaveBeenCalledTimes(1));
    // Only the basename survives; the restore can't escape the archive dir.
    expect(firstZipArg()).toBe(norm("/tmp/archivedcampaigns/evil.zip"));
    expect(firstZipArg()).not.toContain("/etc/");
    pendingRestore[0]({ ok: true });
    expect((await a).statusCode).toBe(200);
  });

  it("rejects a target whose basename isn't a .zip with 400", async () => {
    app = await buildApp();

    const res = await app.inject(restoreReq("/etc/passwd"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid archive/i);
    expect(unarchiveCampaignMock).not.toHaveBeenCalled();
  });
});
