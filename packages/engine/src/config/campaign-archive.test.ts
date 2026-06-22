import {
  archiveCampaign,
  snapshotCampaign,
  unarchiveCampaign,
  listArchivedCampaigns,
  deleteCampaign,
  getCampaignDeleteInfo,
  archiveDir,
} from "./campaign-archive.js";
import type { ArchiveFileIO } from "./campaign-archive.js";
import { norm } from "../utils/paths.js";

// --- In-memory filesystem for testing ---

function createMockIO(): ArchiveFileIO & { fs: Record<string, string | Uint8Array>; dirs: Set<string> } {
  const fs: Record<string, string | Uint8Array> = {};
  const dirs = new Set<string>();
  const mtimes: Record<string, string> = {};

  const io: ArchiveFileIO & { fs: Record<string, string | Uint8Array>; dirs: Set<string> } = {
    fs,
    dirs,
    async readFile(path: string) {
      const p = norm(path);
      const val = fs[p];
      if (val === undefined) throw new Error(`ENOENT: ${p}`);
      if (val instanceof Uint8Array) return new TextDecoder().decode(val);
      return val;
    },
    async readBinary(path: string) {
      const p = norm(path);
      const val = fs[p];
      if (val === undefined) throw new Error(`ENOENT: ${p}`);
      if (val instanceof Uint8Array) return val;
      return new TextEncoder().encode(val);
    },
    async writeFile(path: string, content: string) {
      fs[norm(path)] = content;
    },
    async writeBinary(path: string, data: Uint8Array) {
      fs[norm(path)] = data;
    },
    async mkdir(path: string) {
      dirs.add(norm(path));
    },
    async exists(path: string) {
      const p = norm(path);
      if (p in fs || dirs.has(p)) return true;
      // Also return true if it's a virtual directory (has children in fs)
      const prefix = p + "/";
      for (const key of Object.keys(fs)) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    async listDir(path: string) {
      const p = norm(path).replace(/\/$/, "");
      const entries = new Set<string>();
      for (const key of Object.keys(fs)) {
        if (key.startsWith(p + "/")) {
          const rest = key.slice(p.length + 1);
          const first = rest.split("/")[0];
          entries.add(first);
        }
      }
      // Also check dirs
      for (const d of dirs) {
        if (d.startsWith(p + "/")) {
          const rest = d.slice(p.length + 1);
          const first = rest.split("/")[0];
          if (first && !rest.includes("/")) entries.add(first);
        }
      }
      return [...entries];
    },
    async deleteFile(path: string) {
      const p = norm(path);
      if (!(p in fs)) throw new Error(`ENOENT: ${p}`);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete fs[p];
    },
    async rmdir(path: string) {
      dirs.delete(norm(path));
    },
    async fileMtime(path: string) {
      const p = norm(path);
      return mtimes[p] ?? (p in fs ? "2026-03-25T12:00:00.000Z" : null);
    },
    async isDirectory(path: string) {
      const p = norm(path);
      // A path is a directory if dirs has it OR if any fs key starts with p/
      if (dirs.has(p)) return true;
      for (const key of Object.keys(fs)) {
        if (key.startsWith(p + "/")) return true;
      }
      return false;
    },
  };

  return io;
}

function seedCampaign(io: ReturnType<typeof createMockIO>, campaignPath: string) {
  const p = norm(campaignPath);
  io.fs[`${p}/config.json`] = JSON.stringify({
    name: "Test Campaign",
    players: [{ character: "Kael" }, { character: "Lyra" }],
  });
  io.fs[`${p}/campaign/log.json`] = "[]";
  io.fs[`${p}/characters/kael.md`] = "**Name:** Kael\n\nA bold warrior.";
  io.fs[`${p}/characters/lyra.md`] = "**Name:** Lyra\n\nAn elven mage.";
  io.fs[`${p}/state/display-log.md`] = [
    "The tavern is dimly lit.",
    "A fire crackles in the hearth.",
    "> I look around the room.",
    "You see a barkeep polishing glasses.",
    "The smell of stale ale fills the air.",
    "> I approach the barkeep.",
    "The barkeep looks up and nods.",
  ].join("\n");
}

describe("archiveCampaign", () => {
  it("archives a campaign and produces a zip", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(true);
    expect(result.zipPath).toContain("Test Campaign.zip");

    // Source folder should be deleted
    expect(await io.exists(norm(campaignPath + "/config.json"))).toBe(false);

    // Zip should exist
    expect(await io.exists(result.zipPath!)).toBe(true);
  });

  it("fails on empty campaign folder", async () => {
    const io = createMockIO();
    io.dirs.add(norm("/campaigns/empty"));

    const result = await archiveCampaign("/campaigns/empty", "/campaigns", io);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty or unreadable");
  });

  it("disambiguates when archive zip already exists", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    // Pre-create an existing archive
    const archDir = archiveDir(campaignsDir);
    io.fs[norm(`${archDir}/Test Campaign.zip`)] = "existing";

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(true);
    expect(result.zipPath).toContain("Test Campaign (");
    expect(result.zipPath).toContain(").zip");
  });
});

describe("archiveCampaign read-back verification", () => {
  // Force the post-write read-back (the only `.zip` read inside the build) to
  // misbehave, leaving the rest of the in-memory fs intact.
  function tamperZipReadBack(
    io: ReturnType<typeof createMockIO>,
    handler: (zipReadCount: number) => Uint8Array | "throw" | "passthrough",
  ): () => number {
    const realReadBinary = io.readBinary.bind(io);
    let zipReads = 0;
    io.readBinary = async (path: string) => {
      if (norm(path).endsWith(".zip")) {
        zipReads++;
        const r = handler(zipReads);
        if (r === "throw") throw new Error("EBUSY: resource busy or locked");
        if (r !== "passthrough") return r;
      }
      return realReadBinary(path);
    };
    return () => zipReads;
  }

  it("retries once and succeeds when the first read-back is a transient miss", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);
    // First read-back returns garbage (transient AV/sync hold); the retry reads
    // the real bytes.
    const reads = tamperZipReadBack(io, (n) => (n === 1 ? new Uint8Array([0, 1, 2]) : "passthrough"));

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(true);
    expect(reads()).toBe(2); // proves the retry ran
    // Source is deleted only on success — the round-trip completed.
    expect(await io.exists(norm(campaignPath + "/config.json"))).toBe(false);
  });

  it("fails with both byte lengths after a persistent mismatch", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);
    tamperZipReadBack(io, () => new Uint8Array([0, 1, 2])); // always wrong (3 bytes)

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expected \d+ bytes, read 3/);
    // Fail-safe: the source survives a failed archive.
    expect(await io.exists(norm(campaignPath + "/config.json"))).toBe(true);
  });

  it("fails clearly when the read-back keeps throwing", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);
    tamperZipReadBack(io, () => "throw");

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not read back zip");
    expect(result.error).toContain("EBUSY");
    expect(await io.exists(norm(campaignPath + "/config.json"))).toBe(true);
  });
});

describe("snapshotCampaign", () => {
  it("backs up the campaign without deleting the source", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    const result = await snapshotCampaign(campaignPath, campaignsDir, io, { label: "pre-rollback" });
    expect(result.ok).toBe(true);
    // Source folder is left intact (unlike archiveCampaign).
    expect(await io.exists(norm(campaignPath + "/config.json"))).toBe(true);
    // Zip is always timestamped + labeled, so it's self-describing and unique.
    expect(result.zipPath).toContain("Test Campaign (pre-rollback ");
    expect(result.zipPath).toContain(").zip");
    expect(await io.exists(result.zipPath!)).toBe(true);
  });

  it("produces distinct files for repeated backups (no clobber)", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    const a = await snapshotCampaign(campaignPath, campaignsDir, io, { label: "pre-rollback" });
    const b = await snapshotCampaign(campaignPath, campaignsDir, io, { label: "pre-rollback" });
    expect(a.ok && b.ok).toBe(true);
    expect(a.zipPath).not.toBe(b.zipPath);
    expect(await io.exists(a.zipPath!)).toBe(true);
    expect(await io.exists(b.zipPath!)).toBe(true);
  });

  it("the backup round-trips through unarchive", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    const snap = await snapshotCampaign(campaignPath, campaignsDir, io, { label: "pre-rollback" });
    const restored = await unarchiveCampaign(snap.zipPath!, campaignsDir, io);
    expect(restored.ok).toBe(true);
    expect(await io.exists(norm(`${restored.zipPath}/config.json`))).toBe(true);
  });

  it("excludes the regenerable .debug/ dir from the snapshot", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);
    // Seed a .debug/ dir as the live app would (gitignored context dumps).
    io.fs[norm(`${campaignPath}/.debug/context/dump-1.txt`)] = "huge context dump";
    io.fs[norm(`${campaignPath}/.debug/crash-1.txt`)] = "stack trace";

    const snap = await snapshotCampaign(campaignPath, campaignsDir, io, { label: "pre-rollback" });
    const restored = await unarchiveCampaign(snap.zipPath!, campaignsDir, io);
    expect(restored.ok).toBe(true);
    // Real campaign content survives; the .debug/ dir is dropped.
    expect(await io.exists(norm(`${restored.zipPath}/config.json`))).toBe(true);
    expect(await io.exists(norm(`${restored.zipPath}/.debug/context/dump-1.txt`))).toBe(false);
    expect(await io.exists(norm(`${restored.zipPath}/.debug/crash-1.txt`))).toBe(false);
  });
});

describe("unarchiveCampaign", () => {
  it("unarchives a campaign from a zip", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    // Archive first
    const archResult = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(archResult.ok).toBe(true);

    // Unarchive
    const unarchResult = await unarchiveCampaign(archResult.zipPath!, campaignsDir, io);
    expect(unarchResult.ok).toBe(true);

    // Campaign should be restored
    const restoredPath = unarchResult.zipPath!;
    const configRaw = await io.readFile(norm(`${restoredPath}/config.json`));
    const config = JSON.parse(configRaw);
    expect(config.name).toBe("Test Campaign");
  });

  it("appends suffix when campaign dir already exists", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    // Archive
    const archResult = await archiveCampaign(campaignPath, campaignsDir, io);

    // Create a new campaign at the same slug
    seedCampaign(io, `${campaignsDir}/test-campaign`);

    // Unarchive — should get a suffixed dir
    const unarchResult = await unarchiveCampaign(archResult.zipPath!, campaignsDir, io);
    expect(unarchResult.ok).toBe(true);
    expect(unarchResult.zipPath).toContain("test-campaign-2");
  });

  it("fails on corrupt zip", async () => {
    const io = createMockIO();
    io.fs[norm("/archives/bad.zip")] = new Uint8Array([1, 2, 3, 4]);

    const result = await unarchiveCampaign("/archives/bad.zip", "/campaigns", io);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("corrupt");
  });
});

describe("listArchivedCampaigns", () => {
  it("lists archived zips with dates", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const archDir = archiveDir(campaignsDir);
    io.fs[norm(`${archDir}/My Campaign.zip`)] = "data";
    io.fs[norm(`${archDir}/Another.zip`)] = "data2";
    io.fs[norm(`${archDir}/notes.txt`)] = "not a zip"; // should be skipped

    const entries = await listArchivedCampaigns(campaignsDir, io);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name)).toContain("My Campaign");
    expect(entries.map((e) => e.name)).toContain("Another");
    expect(entries[0].archivedDate).toBeTruthy();
  });

  it("returns empty array when no archive dir", async () => {
    const io = createMockIO();
    const entries = await listArchivedCampaigns("/nonexistent", io);
    expect(entries).toEqual([]);
  });
});

describe("archiveCampaign binary preservation", () => {
  it("preserves binary git objects through archive round-trip", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/test-campaign`;
    seedCampaign(io, campaignPath);

    // Add a binary git object (not valid UTF-8)
    const binaryData = new Uint8Array([0x00, 0x78, 0x9c, 0xff, 0xfe, 0x01, 0x80, 0x90]);
    io.fs[norm(`${campaignPath}/state/.git/objects/ab/cdef`)] = binaryData;

    // Archive
    const archResult = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(archResult.ok).toBe(true);

    // Unarchive
    const unarchResult = await unarchiveCampaign(archResult.zipPath!, campaignsDir, io);
    expect(unarchResult.ok).toBe(true);

    // Binary object should be byte-identical
    const restored = await io.readBinary(norm(`${unarchResult.zipPath}/state/.git/objects/ab/cdef`));
    expect(restored).toEqual(binaryData);
  });
});

describe("archiveCampaign filename sanitization", () => {
  it("sanitizes path separators in campaign names", async () => {
    const io = createMockIO();
    const campaignsDir = "/home/user/campaigns";
    const campaignPath = `${campaignsDir}/evil`;
    const p = norm(campaignPath);
    io.fs[`${p}/config.json`] = JSON.stringify({ name: "../../../etc/passwd" });
    io.fs[`${p}/data.txt`] = "some data";

    const result = await archiveCampaign(campaignPath, campaignsDir, io);
    expect(result.ok).toBe(true);
    // Should not contain path traversal in the zip filename
    expect(result.zipPath).not.toContain("..");
    expect(result.zipPath).toContain(".zip");
  });
});

describe("deleteCampaign", () => {
  it("recursively deletes a campaign folder", async () => {
    const io = createMockIO();
    seedCampaign(io, "/campaigns/doomed");

    const result = await deleteCampaign("/campaigns/doomed", io);
    expect(result.ok).toBe(true);
    expect(await io.exists(norm("/campaigns/doomed/config.json"))).toBe(false);
  });
});

describe("getCampaignDeleteInfo", () => {
  it("extracts campaign name, characters, and DM turn count", async () => {
    const io = createMockIO();
    seedCampaign(io, "/campaigns/test");

    const info = await getCampaignDeleteInfo("/campaigns/test", io);
    expect(info.campaignName).toBe("Test Campaign");
    expect(info.characterNames).toEqual(["Kael", "Lyra"]);
    // The display log has 3 DM "blocks" (lines before first >, between the two >, and after second >)
    expect(info.dmTurnCount).toBe(3);
  });

  it("handles missing config gracefully", async () => {
    const io = createMockIO();
    io.fs[norm("/campaigns/bare/readme.md")] = "hello";

    const info = await getCampaignDeleteInfo("/campaigns/bare", io);
    expect(info.campaignName).toBe("bare");
    expect(info.characterNames).toEqual([]);
    expect(info.dmTurnCount).toBe(0);
  });
});
