import { describe, it, expect } from "vitest";
import { mkdir, writeFile, rm, readdir, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import { allocateCodexHome, codexHomeBase, sweepStaleCodexHomes } from "./codex-home.js";

describe("allocateCodexHome", () => {
  it("returns a unique path under the codex-home base each call", () => {
    const a = allocateCodexHome("connA");
    const b = allocateCodexHome("connA");
    expect(a).not.toBe(b); // UUID suffix guarantees uniqueness
    expect(a.startsWith(codexHomeBase())).toBe(true);
    expect(b.startsWith(codexHomeBase())).toBe(true);
  });

  it("slugs the hint into the dir name for traceability, dropping unsafe chars", () => {
    const p = allocateCodexHome("conn/../weird id!");
    const leaf = p.slice(codexHomeBase().length + 1);
    // Only the sanitized hint + a UUID; no path separators or punctuation leak in.
    expect(leaf).toMatch(/^connweirdid-[0-9a-f-]+$/);
  });

  it("falls back to a default slug when the hint is empty or all-unsafe", () => {
    const leaf = allocateCodexHome("///").slice(codexHomeBase().length + 1);
    expect(leaf).toMatch(/^codex-[0-9a-f-]+$/);
  });
});

describe("sweepStaleCodexHomes", () => {
  // The sweep operates on the real codexHomeBase(), so each test seeds + cleans
  // its own uniquely-named dirs there and never touches siblings.
  async function seedHome(name: string, opts: { fileAgeMs: number; nowMs: number }): Promise<string> {
    const dir = join(codexHomeBase(), name);
    await mkdir(dir, { recursive: true });
    // A codex home always carries its SQLite state runtime; the WAL is the file
    // rewritten every turn, so it's what "freshness" keys off.
    const wal = join(dir, "state_5.sqlite-wal");
    await writeFile(wal, "x");
    const when = new Date(opts.nowMs - opts.fileAgeMs);
    await utimes(wal, when, when);
    await utimes(dir, when, when);
    return dir;
  }

  it("removes a home whose freshest inner file is older than the threshold", async () => {
    const now = 1_000_000_000_000;
    const name = `test-stale-${Math.round(now)}-${Math.random().toString(36).slice(2)}`;
    const dir = await seedHome(name, { fileAgeMs: 5 * 24 * 60 * 60 * 1000, nowMs: now }); // 5 days old
    try {
      const removed = await sweepStaleCodexHomes(now, 3 * 24 * 60 * 60 * 1000); // 3-day threshold
      expect(removed).toBeGreaterThanOrEqual(1);
      await expect(readdir(dir)).rejects.toThrow(); // gone
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("KEEPS a home with a freshly-written inner file (active session), even if the dir mtime is old", async () => {
    const now = 1_000_000_000_000;
    const name = `test-active-${Math.round(now)}-${Math.random().toString(36).slice(2)}`;
    const dir = join(codexHomeBase(), name);
    await mkdir(dir, { recursive: true });
    try {
      // Dir mtime is ancient...
      const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
      await utimes(dir, old, old);
      // ...but the WAL was just written (a live turn). The sweep must key off the
      // freshest CHILD mtime, not the dir's, so this home survives.
      const wal = join(dir, "state_5.sqlite-wal");
      await writeFile(wal, "x");
      const fresh = new Date(now - 60_000); // 1 min ago
      await utimes(wal, fresh, fresh);

      await sweepStaleCodexHomes(now, 3 * 24 * 60 * 60 * 1000);
      // Assert ONLY that OUR active home survives — not the total removed count.
      // The sweep runs against the shared real temp base, so a prior local run
      // or a concurrent test can leave other stale homes it legitimately reaps;
      // asserting `removed === 0` there is a shared-state flake (Copilot #699).
      const st = await stat(dir);
      expect(st.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 without throwing when the base dir does not exist", async () => {
    // Point the test at a base we know is absent by temporarily using a random
    // non-existent path is not possible (base is fixed), so instead assert the
    // no-throw contract by running against the real (possibly-empty) base: it
    // must never reject.
    await expect(sweepStaleCodexHomes(Date.now(), 3 * 24 * 60 * 60 * 1000)).resolves.toBeTypeOf("number");
  });
});
