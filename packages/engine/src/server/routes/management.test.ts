import Fastify, { type FastifyInstance } from "fastify";
import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";

// The archive route's concurrency guard is the unit under test: a second
// archive of the SAME campaign while the first is in flight must be rejected
// (409), not run concurrently — two overlapping archives race the same zip
// path and source deletion, corrupting the archive ("contents mismatch on
// disk"). archiveCampaign itself is covered in campaign-archive.test.ts, so we
// replace it with a controllable deferred to make the overlap deterministic.
interface ArchiveResult { ok: boolean; zipPath?: string; error?: string }

// Created via vi.hoisted so they exist before vi.mock's factory (hoisted to the
// top of the module) references them.
const { archiveCampaignMock, pending } = vi.hoisted(() => {
  const pending: ((v: ArchiveResult) => void)[] = [];
  const archiveCampaignMock = vi.fn(() => new Promise<ArchiveResult>((res) => { pending.push(res); }));
  return { archiveCampaignMock, pending };
});

vi.mock("../../config/campaign-archive.js", () => ({
  archiveCampaign: archiveCampaignMock,
  deleteCampaign: vi.fn(),
  listArchivedCampaigns: vi.fn(),
  unarchiveCampaign: vi.fn(),
  getCampaignDeleteInfo: vi.fn(),
  // The route gets its ArchiveFileIO from ../fileio.js, which re-exports this
  // from the mocked module — stub it so the call doesn't throw (the mocked
  // archiveCampaign ignores the io anyway).
  createArchiveFileIO: vi.fn(() => ({})),
}));

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
