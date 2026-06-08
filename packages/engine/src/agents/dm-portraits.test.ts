import { describe, it, expect, vi } from "vitest";
import { loadDmPortraitMessage, loadCharacterReferences } from "./dm-portraits.js";
import type { FileIO } from "./scene-manager.js";
import { norm } from "../utils/paths.js";
import { campaignPaths } from "../tools/filesystem/index.js";

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

  it("returns a synthetic non-ephemeral user message with image_input blocks for present portraits", async () => {
    const paths = campaignPaths("/camp");
    const janeyPath = paths.characterPortrait("Janey Bruce");
    const orosPath = paths.characterPortrait("Oros");
    const io = makeFileIO({
      [janeyPath]: new Uint8Array([1, 2, 3]),
      [orosPath]: new Uint8Array([4, 5, 6]),
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
      mimeType: "image/png",
      lowDetail: true,
      label: "Janey Bruce",
    });
    expect(content[2]).toMatchObject({
      type: "image_input",
      mimeType: "image/png",
      lowDetail: true,
      label: "Oros",
    });
    // Bytes round-trip correctly through base64.
    expect((content[1] as { base64: string }).base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect((content[2] as { base64: string }).base64).toBe(Buffer.from([4, 5, 6]).toString("base64"));
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
