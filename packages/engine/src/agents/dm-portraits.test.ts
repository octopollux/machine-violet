import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import {
  loadDmPortraitMessage,
  loadCharacterReferences,
  downscalePortraitForContext,
  commitPortraitRevision,
} from "./dm-portraits.js";
import type { FileIO } from "./scene-manager.js";
import { norm } from "../utils/paths.js";
import { campaignPaths } from "../tools/filesystem/index.js";

/** In-memory FileIO with working binary read/write/listDir, for revision tests. */
function makeRWFileIO(initial: Record<string, Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) store.set(norm(k), v);
  const dirs = new Set<string>();
  const io: FileIO = {
    readFile: async () => { throw new Error("unused"); },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async (p) => { dirs.add(norm(p)); },
    exists: async (p) => store.has(norm(p)) || dirs.has(norm(p)),
    listDir: async (p) => {
      const prefix = norm(p) + "/";
      const names = new Set<string>();
      for (const k of store.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      return [...names];
    },
    readBinaryFile: async (p) => {
      const k = norm(p);
      if (!store.has(k)) throw new Error(`ENOENT: ${p}`);
      return store.get(k)!;
    },
    writeBinaryFile: async (p, bytes) => { store.set(norm(p), bytes); },
  };
  return { io, store };
}

/** Produce a real solid-color PNG of the given square size — valid input for sharp. */
async function makePng(size: number, rgb: { r: number; g: number; b: number }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: size, height: size, channels: 3, background: rgb } })
      .png()
      .toBuffer(),
  );
}

function makeFileIO(present: Record<string, Uint8Array>) {
  const normalized = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(present)) normalized.set(norm(k), v);
  const io: FileIO = {
    readFile: async () => { throw new Error("unused"); },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async (p) => normalized.has(norm(p)),
    listDir: async () => [],
    readBinaryFile: async (p) => {
      const k = norm(p);
      if (!normalized.has(k)) throw new Error(`ENOENT: ${p}`);
      return normalized.get(k)!;
    },
  };
  return io;
}

describe("loadDmPortraitMessage", () => {
  it("returns null when no PC has a portrait on disk (text-only DM context)", async () => {
    const io = makeFileIO({});
    const msg = await loadDmPortraitMessage(
      [{ character: "Janey Bruce" }, { character: "Oros" }],
      io,
      "/camp",
    );
    expect(msg).toBeNull();
  });

  it("returns a synthetic non-ephemeral user message with downscaled WebP image_input blocks for present portraits", async () => {
    const paths = campaignPaths("/camp");
    const janeyPath = paths.characterPortrait("Janey Bruce");
    const orosPath = paths.characterPortrait("Oros");
    const io = makeFileIO({
      [janeyPath]: await makePng(800, { r: 200, g: 40, b: 40 }),
      [orosPath]: await makePng(800, { r: 40, g: 40, b: 200 }),
    });

    const msg = await loadDmPortraitMessage(
      [{ character: "Janey Bruce" }, { character: "Oros" }],
      io,
      "/camp",
    );

    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
    expect(msg!.ephemeral).toBe(false);

    const content = msg!.content as { type: string }[];
    expect(content).toHaveLength(3); // 1 text intro + 2 image_input
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toMatchObject({
      type: "image_input",
      mimeType: "image/webp", // re-encoded small copy, not the full-res PNG
      lowDetail: true,
      label: "Janey Bruce",
    });
    expect(content[2]).toMatchObject({
      type: "image_input",
      mimeType: "image/webp",
      lowDetail: true,
      label: "Oros",
    });
    // The through-routed bytes are a genuine ≤512px WebP, not the 800px source.
    const janeyMeta = await sharp(Buffer.from((content[1] as { base64: string }).base64, "base64")).metadata();
    expect(janeyMeta.format).toBe("webp");
    expect(Math.max(janeyMeta.width ?? 0, janeyMeta.height ?? 0)).toBeLessThanOrEqual(512);
  });

  it("skips PCs whose portrait file is missing (mid-campaign opt-in works without all PCs covered)", async () => {
    // Janey has a portrait; Oros doesn't. Robustness memory says this must
    // still produce a valid message — DM authors Oros's appearance from text.
    const paths = campaignPaths("/camp");
    const io = makeFileIO({
      [paths.characterPortrait("Janey Bruce")]: new Uint8Array([1]),
    });
    const msg = await loadDmPortraitMessage(
      [{ character: "Janey Bruce" }, { character: "Oros" }],
      io,
      "/camp",
    );
    const content = msg!.content as { type: string; label?: string }[];
    expect(content).toHaveLength(2); // text intro + Janey only
    expect(content[1]).toMatchObject({ type: "image_input", label: "Janey Bruce" });
    expect(content.find((c) => c.label === "Oros")).toBeUndefined();
  });

  it("returns null when fileIO has no readBinaryFile (legacy mock — no throw)", async () => {
    const io: FileIO = {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async () => true,
      listDir: async () => [],
      // readBinaryFile intentionally absent
    };
    const msg = await loadDmPortraitMessage([{ character: "X" }], io, "/camp");
    expect(msg).toBeNull();
  });

  it("survives a single corrupted/unreadable portrait — emits the message with the rest", async () => {
    const paths = campaignPaths("/camp");
    const goodPath = paths.characterPortrait("Good");
    const badPath = paths.characterPortrait("Bad");
    const io: FileIO = {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async (p) => norm(p) === norm(goodPath) || norm(p) === norm(badPath),
      listDir: async () => [],
      readBinaryFile: vi.fn(async (p: string) => {
        if (norm(p) === norm(badPath)) throw new Error("EACCES");
        return new Uint8Array([9]);
      }),
    };
    const msg = await loadDmPortraitMessage(
      [{ character: "Good" }, { character: "Bad" }],
      io,
      "/camp",
    );
    const content = msg!.content as { type: string; label?: string }[];
    // text intro + Good's portrait only — Bad is silently dropped
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ label: "Good" });
  });
});

describe("downscalePortraitForContext", () => {
  it("downscales a large portrait to a ≤512px WebP", async () => {
    const png = await makePng(800, { r: 200, g: 40, b: 40 });
    const { base64, mimeType } = await downscalePortraitForContext(png);
    expect(mimeType).toBe("image/webp");
    const meta = await sharp(Buffer.from(base64, "base64")).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512);
    // The point of the exercise: the through-routed copy is dramatically
    // smaller than the full-res source.
    expect(base64.length).toBeLessThan(Buffer.from(png).toString("base64").length);
  });

  it("does not upscale a portrait already smaller than the cap", async () => {
    const png = await makePng(128, { r: 10, g: 10, b: 200 });
    const { base64, mimeType } = await downscalePortraitForContext(png);
    expect(mimeType).toBe("image/webp");
    const meta = await sharp(Buffer.from(base64, "base64")).metadata();
    expect(meta.width).toBe(128); // withoutEnlargement — no blurry upscale
  });

  it("falls back to the original bytes as PNG when sharp can't decode the input", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4]);
    const { base64, mimeType } = await downscalePortraitForContext(garbage);
    // Robustness: a slightly larger upload beats dropping the PC's likeness.
    expect(mimeType).toBe("image/png");
    expect(base64).toBe(Buffer.from(garbage).toString("base64"));
  });
});

describe("commitPortraitRevision", () => {
  const paths = campaignPaths("/camp");

  it("archives the existing portrait and swaps in the new bytes", async () => {
    const cur = paths.characterPortrait("Janey Bruce");
    const { io, store } = makeRWFileIO({ [cur]: new Uint8Array([1, 1, 1]) });

    const { archivedVersion } = await commitPortraitRevision(io, "/camp", "Janey Bruce", new Uint8Array([2, 2, 2]));

    expect(archivedVersion).toBe(1);
    expect([...store.get(norm(cur))!]).toEqual([2, 2, 2]); // current = new
    expect([...store.get(norm(paths.characterPortraitArchive("Janey Bruce", 1)))!]).toEqual([1, 1, 1]); // prior archived
  });

  it("increments the archive version across repeated revisions", async () => {
    const cur = paths.characterPortrait("Janey Bruce");
    const { io, store } = makeRWFileIO({ [cur]: new Uint8Array([1]) });

    await commitPortraitRevision(io, "/camp", "Janey Bruce", new Uint8Array([2]));
    const second = await commitPortraitRevision(io, "/camp", "Janey Bruce", new Uint8Array([3]));

    expect(second.archivedVersion).toBe(2);
    expect([...store.get(norm(cur))!]).toEqual([3]);
    expect([...store.get(norm(paths.characterPortraitArchive("Janey Bruce", 1)))!]).toEqual([1]);
    expect([...store.get(norm(paths.characterPortraitArchive("Janey Bruce", 2)))!]).toEqual([2]);
  });

  it("archives nothing on a first-ever write (no prior portrait)", async () => {
    const cur = paths.characterPortrait("Oros");
    const { io, store } = makeRWFileIO({});

    const { archivedVersion } = await commitPortraitRevision(io, "/camp", "Oros", new Uint8Array([9]));

    expect(archivedVersion).toBeNull();
    expect([...store.get(norm(cur))!]).toEqual([9]);
  });

  it("no-ops (null) when fileIO lacks writeBinaryFile", async () => {
    const io: FileIO = {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async () => true,
      listDir: async () => [],
      // no binary capability
    };
    expect(await commitPortraitRevision(io, "/camp", "X", new Uint8Array([1]))).toEqual({ archivedVersion: null });
  });
});

describe("loadCharacterReferences", () => {
  it("resolves named characters to provider referenceImages (base64 + label)", async () => {
    const paths = campaignPaths("/camp");
    const io = makeFileIO({
      [paths.characterPortrait("Janey Bruce")]: new Uint8Array([1, 2, 3]),
      [paths.characterPortrait("Oros")]: new Uint8Array([4, 5, 6]),
    });

    const refs = await loadCharacterReferences(["Janey Bruce", "Oros"], io, "/camp");

    expect(refs).toEqual([
      { base64: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png", label: "Janey Bruce" },
      { base64: Buffer.from([4, 5, 6]).toString("base64"), mimeType: "image/png", label: "Oros" },
    ]);
  });

  it("skips names with no portrait on disk (partial match still conditions on the rest)", async () => {
    const paths = campaignPaths("/camp");
    const io = makeFileIO({ [paths.characterPortrait("Janey Bruce")]: new Uint8Array([1]) });

    const refs = await loadCharacterReferences(["Janey Bruce", "Nobody"], io, "/camp");

    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBe("Janey Bruce");
  });

  it("returns [] when no named character has a portrait (caller renders text-only)", async () => {
    const refs = await loadCharacterReferences(["Ghost", "Phantom"], makeFileIO({}), "/camp");
    expect(refs).toEqual([]);
  });

  it("deduplicates by resolved portrait path (same character named twice)", async () => {
    const paths = campaignPaths("/camp");
    const io = makeFileIO({ [paths.characterPortrait("Janey Bruce")]: new Uint8Array([7]) });

    // "Janey Bruce" and "the janey bruce" slugify to the same portrait file.
    const refs = await loadCharacterReferences(["Janey Bruce", "Janey Bruce", "the Janey Bruce"], io, "/camp");

    expect(refs).toHaveLength(1);
  });

  it("ignores blank / whitespace-only names", async () => {
    const paths = campaignPaths("/camp");
    const io = makeFileIO({ [paths.characterPortrait("Oros")]: new Uint8Array([2]) });

    const refs = await loadCharacterReferences(["", "   ", "Oros"], io, "/camp");

    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBe("Oros");
  });

  it("returns [] when fileIO has no readBinaryFile (legacy mock — no throw)", async () => {
    const io: FileIO = {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async () => true,
      listDir: async () => [],
      // readBinaryFile intentionally absent
    };
    expect(await loadCharacterReferences(["X"], io, "/camp")).toEqual([]);
  });

  it("survives a single corrupted/unreadable portrait — returns the rest", async () => {
    const paths = campaignPaths("/camp");
    const goodPath = paths.characterPortrait("Good");
    const badPath = paths.characterPortrait("Bad");
    const io: FileIO = {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async (p) => norm(p) === norm(goodPath) || norm(p) === norm(badPath),
      listDir: async () => [],
      readBinaryFile: vi.fn(async (p: string) => {
        if (norm(p) === norm(badPath)) throw new Error("EACCES");
        return new Uint8Array([9]);
      }),
    };

    const refs = await loadCharacterReferences(["Good", "Bad"], io, "/camp");

    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBe("Good");
  });
});
