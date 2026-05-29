import { describe, it, expect, vi } from "vitest";
import { resolve, sep } from "node:path";
import { sandboxFileIO } from "./sandbox.js";
import type { FileIO } from "../../agents/scene-manager.js";

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn(async () => "content"),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    listDir: vi.fn(async () => ["a.md", "b.md"]),
    deleteFile: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
  };
}

const ROOT = resolve("/campaigns/test-campaign");
const CONTENT_ROOT = resolve("/campaigns/shared-content");

describe("sandboxFileIO", () => {
  it("throws if no allowed roots provided", () => {
    expect(() => sandboxFileIO(mockFileIO(), [])).toThrow("at least one allowed root");
  });

  it("allows reads within campaign root", async () => {
    const inner = mockFileIO();
    const sandboxed = sandboxFileIO(inner, [ROOT]);

    await sandboxed.readFile(ROOT + sep + "characters" + sep + "kael.md");
    expect(inner.readFile).toHaveBeenCalledWith(
      resolve(ROOT, "characters", "kael.md"),
    );
  });

  it("allows reads of the root directory itself", async () => {
    const inner = mockFileIO();
    const sandboxed = sandboxFileIO(inner, [ROOT]);

    await sandboxed.listDir(ROOT);
    expect(inner.listDir).toHaveBeenCalled();
  });

  it("rejects paths outside all roots", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.readFile(resolve("/etc/passwd")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("rejects .. traversal out of root", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.readFile(ROOT + sep + ".." + sep + "other-campaign" + sep + "secrets.md"),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("supports multiple allowed roots", async () => {
    const inner = mockFileIO();
    const sandboxed = sandboxFileIO(inner, [ROOT, CONTENT_ROOT]);

    // Campaign root works
    await sandboxed.readFile(ROOT + sep + "characters" + sep + "kael.md");
    expect(inner.readFile).toHaveBeenCalledTimes(1);

    // Content root works
    await sandboxed.readFile(CONTENT_ROOT + sep + "dnd-5e" + sep + "classes.md");
    expect(inner.readFile).toHaveBeenCalledTimes(2);
  });

  it("rejects paths between roots (sibling traversal)", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT, CONTENT_ROOT]);

    await expect(
      sandboxed.readFile(resolve("/campaigns/other-campaign/secrets.md")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards writeFile", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.writeFile(resolve("/tmp/evil.sh"), "bad"),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards appendFile", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.appendFile(resolve("/tmp/evil.log"), "bad"),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards mkdir", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.mkdir(resolve("/tmp/evil-dir")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards exists", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.exists(resolve("/etc/shadow")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards listDir", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.listDir(resolve("/etc")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("guards deleteFile", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.deleteFile!(resolve("/important/data.db")),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("propagates deleteFile only when inner supports it", () => {
    const inner = mockFileIO();
    delete inner.deleteFile;
    const sandboxed = sandboxFileIO(inner, [ROOT]);

    expect(sandboxed.deleteFile).toBeUndefined();
  });

  it("guards writeBinaryFile", async () => {
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.writeBinaryFile!(resolve("/tmp/evil.png"), new Uint8Array([0])),
    ).rejects.toThrow("Path outside sandbox");
  });

  it("propagates writeBinaryFile only when inner supports it", () => {
    const inner = mockFileIO();
    delete inner.writeBinaryFile;
    const sandboxed = sandboxFileIO(inner, [ROOT]);

    expect(sandboxed.writeBinaryFile).toBeUndefined();
  });

  it("forwards writeBinaryFile to inner with guarded path", async () => {
    // Regression: a prior version of sandboxFileIO never forwarded
    // writeBinaryFile at all, which caused image persistence to throw
    // "FileIO.writeBinaryFile is required" against the production
    // sandbox-wrapped FileIO. Make sure the forward survives any future
    // refactor of this file.
    const inner = mockFileIO();
    const sandboxed = sandboxFileIO(inner, [ROOT]);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await sandboxed.writeBinaryFile!(ROOT + sep + "images" + sep + "portrait.png", bytes);
    expect(inner.writeBinaryFile).toHaveBeenCalledWith(
      resolve(ROOT, "images", "portrait.png"),
      bytes,
    );
  });

  it("prevents root prefix spoofing", async () => {
    // /campaigns/test-campaign-evil should NOT match /campaigns/test-campaign
    const sandboxed = sandboxFileIO(mockFileIO(), [ROOT]);

    await expect(
      sandboxed.readFile(resolve(ROOT + "-evil", "payload.md")),
    ).rejects.toThrow("Path outside sandbox");
  });
});
