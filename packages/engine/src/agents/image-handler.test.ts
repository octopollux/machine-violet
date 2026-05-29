import { describe, it, expect, vi } from "vitest";
import { handleImageGenerated, type ImageGeneratedPart } from "./image-handler.js";
import type { FileIO } from "./scene-manager.js";
import { norm } from "../utils/paths.js";

function makeFileIO() {
  const text = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  const mkdir = vi.fn(async () => {});
  const writeFile = vi.fn(async (p: string, c: string) => { text.set(norm(p), c); });
  const writeBinaryFile = vi.fn(async (p: string, b: Uint8Array) => { binary.set(norm(p), b); });
  const io: FileIO = {
    readFile: async () => { throw new Error("not used"); },
    writeFile,
    writeBinaryFile,
    appendFile: async () => {},
    mkdir,
    exists: async () => false,
    listDir: async () => [],
  };
  return { io, text, binary, mkdir, writeFile, writeBinaryFile };
}

function basePart(overrides: Partial<ImageGeneratedPart> = {}): ImageGeneratedPart {
  return {
    id: "ig_1",
    base64: Buffer.from("PNG-FAKE").toString("base64"),
    mimeType: "image/png",
    intent: "player_request",
    ...overrides,
  };
}

describe("handleImageGenerated", () => {
  it("writes the PNG bytes under campaign/images and returns a relative path", async () => {
    const { io, binary } = makeFileIO();
    const result = await handleImageGenerated(io, "/camp", { sceneNumber: 1, slug: "tavern" }, basePart(), () => 1234);
    expect(result.relPath).toBe("campaign/images/request-1234.png");
    expect(binary.size).toBe(1);
    const [key, bytes] = [...binary.entries()][0];
    expect(key).toBe(norm("/camp/campaign/images/request-1234.png"));
    expect(Buffer.from(bytes).toString()).toBe("PNG-FAKE");
  });

  it("scene_snapshot filename encodes scene number, slug, and timestamp", async () => {
    const { io } = makeFileIO();
    const result = await handleImageGenerated(io, "/camp",
      { sceneNumber: 42, slug: "big-fight" },
      basePart({ intent: "scene_snapshot" }),
      () => 9999,
    );
    expect(result.relPath).toBe("campaign/images/scene-042-big-fight-9999.png");
  });

  it("character_portrait drafts land in images/ with a draft prefix (final path is setup-agent's responsibility)", async () => {
    const { io } = makeFileIO();
    const result = await handleImageGenerated(io, "/camp", null,
      basePart({ intent: "character_portrait" }), () => 7,
    );
    expect(result.relPath).toBe("campaign/images/portrait-draft-7.png");
  });

  it("writes a sidecar .json carrying revisedPrompt + intent + scene context", async () => {
    const { io, text } = makeFileIO();
    await handleImageGenerated(io, "/camp", { sceneNumber: 3, slug: "alley" },
      basePart({ intent: "scene_snapshot", revisedPrompt: "An alley at dawn." }),
      () => 555,
    );
    const sidecarPath = norm("/camp/campaign/images/scene-003-alley-555.json");
    expect(text.has(sidecarPath)).toBe(true);
    const parsed = JSON.parse(text.get(sidecarPath)!);
    expect(parsed).toMatchObject({
      id: "ig_1",
      intent: "scene_snapshot",
      timestamp: 555,
      mimeType: "image/png",
      sceneNumber: 3,
      sceneSlug: "alley",
      revisedPrompt: "An alley at dawn.",
    });
  });

  it("omits sceneNumber/sceneSlug from sidecar when scene is null", async () => {
    const { io, text } = makeFileIO();
    await handleImageGenerated(io, "/camp", null, basePart(), () => 100);
    const sidecar = JSON.parse(text.get(norm("/camp/campaign/images/request-100.json"))!);
    expect(sidecar).not.toHaveProperty("sceneNumber");
    expect(sidecar).not.toHaveProperty("sceneSlug");
  });

  it("ensures the images directory exists before writing", async () => {
    const { io, mkdir } = makeFileIO();
    await handleImageGenerated(io, "/camp", null, basePart(), () => 1);
    expect(mkdir).toHaveBeenCalledWith(expect.stringMatching(/campaign[\\/]images$/));
  });

  it("throws when FileIO.writeBinaryFile is absent — better than silently dropping bytes", async () => {
    const { io } = makeFileIO();
    delete (io as Partial<FileIO>).writeBinaryFile;
    await expect(
      handleImageGenerated(io, "/camp", null, basePart()),
    ).rejects.toThrow(/writeBinaryFile/);
  });

  it("uses jpg/webp extensions for those MIME types", async () => {
    const { io } = makeFileIO();
    const jpg = await handleImageGenerated(io, "/camp", null,
      basePart({ mimeType: "image/jpeg" }), () => 1,
    );
    expect(jpg.relPath).toMatch(/\.jpg$/);
    const webp = await handleImageGenerated(io, "/camp", null,
      basePart({ mimeType: "image/webp" }), () => 2,
    );
    expect(webp.relPath).toMatch(/\.webp$/);
  });
});
