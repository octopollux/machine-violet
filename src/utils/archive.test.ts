import { zipFiles, unzipFiles, setArchiveIO, sanitizePath } from "./archive.js";
import type { ArchiveIO, FileMap } from "./archive.js";

afterEach(() => {
  setArchiveIO(null);
});

describe("zipFiles / unzipFiles round-trip", () => {
  it("round-trips a single file", () => {
    const input: FileMap = { "hello.txt": "world" };
    const zipped = zipFiles(input);
    expect(zipped).toBeInstanceOf(Uint8Array);
    const output = unzipFiles(zipped!);
    expect(output).toEqual(input);
  });

  it("round-trips multiple files with nested paths", () => {
    const input: FileMap = {
      "campaign/state.json": '{"turn":1}',
      "campaign/transcript.md": "# Scene 1\nThe party enters.",
      "campaign/entities/npc/barkeep.md": "**Name:** Grog",
    };
    const zipped = zipFiles(input);
    expect(zipped).not.toBeNull();
    const output = unzipFiles(zipped!);
    expect(output).toEqual(input);
  });

  it("round-trips empty files", () => {
    const input: FileMap = { "empty.txt": "" };
    const zipped = zipFiles(input);
    const output = unzipFiles(zipped!);
    expect(output).toEqual(input);
  });

  it("round-trips unicode content", () => {
    const input: FileMap = { "runes.md": "ᚠᚢᚦᚨᚱᚲ — Elder Futhark 🎲" };
    const zipped = zipFiles(input);
    const output = unzipFiles(zipped!);
    expect(output).toEqual(input);
  });

  it("handles an empty file map", () => {
    const zipped = zipFiles({});
    expect(zipped).not.toBeNull();
    const output = unzipFiles(zipped!);
    expect(output).toEqual({});
  });
});

describe("sanitizePath", () => {
  it("passes through clean relative paths", () => {
    expect(sanitizePath("campaign/state.json")).toBe("campaign/state.json");
    expect(sanitizePath("file.txt")).toBe("file.txt");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(sanitizePath("campaign\\entities\\npc.md")).toBe("campaign/entities/npc.md");
  });

  it("strips leading slashes", () => {
    expect(sanitizePath("/campaign/file.txt")).toBe("campaign/file.txt");
    expect(sanitizePath("///deep/path.md")).toBe("deep/path.md");
  });

  it("collapses . segments", () => {
    expect(sanitizePath("./campaign/./file.txt")).toBe("campaign/file.txt");
  });

  it("rejects .. traversal segments", () => {
    expect(sanitizePath("../etc/passwd")).toBeNull();
    expect(sanitizePath("campaign/../../secret")).toBeNull();
    expect(sanitizePath("..")).toBeNull();
  });

  it("rejects Windows drive letters", () => {
    expect(sanitizePath("C:/Windows/system32")).toBeNull();
    expect(sanitizePath("d:\\data\\file.txt")).toBeNull();
  });

  it("rejects NUL bytes", () => {
    expect(sanitizePath("file\0.txt")).toBeNull();
  });

  it("rejects empty paths", () => {
    expect(sanitizePath("")).toBeNull();
    expect(sanitizePath("/")).toBeNull();
    expect(sanitizePath("./")).toBeNull();
  });
});

describe("zipFiles error handling", () => {
  it("returns null when zip throws", () => {
    setArchiveIO({
      zip: () => { throw new Error("boom"); },
      unzip: () => ({}),
    });
    expect(zipFiles({ "a.txt": "a" })).toBeNull();
  });

  it("returns null when paths contain traversal", () => {
    expect(zipFiles({ "../../etc/passwd": "root" })).toBeNull();
  });

  it("normalizes leading slashes on zip (not rejected, just stripped)", () => {
    const zipped = zipFiles({ "/campaign/file.txt": "data" });
    expect(zipped).not.toBeNull();
    const output = unzipFiles(zipped!);
    expect(output).toEqual({ "campaign/file.txt": "data" });
  });

  it("returns null for Windows drive paths", () => {
    expect(zipFiles({ "C:/Windows/system32/config": "data" })).toBeNull();
  });
});

describe("unzipFiles error handling", () => {
  it("returns null for corrupt data", () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
    expect(unzipFiles(garbage)).toBeNull();
  });

  it("returns null when unzip throws", () => {
    setArchiveIO({
      zip: () => new Uint8Array(),
      unzip: () => { throw new Error("boom"); },
    });
    expect(unzipFiles(new Uint8Array())).toBeNull();
  });
});

describe("unzip path sanitization (zip-slip protection)", () => {
  it("silently drops entries with traversal paths from a crafted zip", async () => {
    // Use fflate directly to create a zip with malicious entry names
    const { zipSync, strToU8 } = await import("fflate");
    const malicious = zipSync({
      "campaign/safe.txt": strToU8("safe"),
      "../../etc/passwd": strToU8("pwned"),
      "C:/Windows/evil.dll": strToU8("pwned"),
    });

    const output = unzipFiles(malicious);
    expect(output).not.toBeNull();
    expect(output!["campaign/safe.txt"]).toBe("safe");
    expect(Object.keys(output!)).toEqual(["campaign/safe.txt"]);
  });
});

describe("setArchiveIO", () => {
  it("allows injecting a mock implementation", () => {
    const mockFiles: FileMap = { "mock.txt": "mocked" };
    const mock: ArchiveIO = {
      zip: () => new Uint8Array([42]),
      unzip: () => mockFiles,
    };
    setArchiveIO(mock);

    expect(zipFiles({ "a.txt": "a" })).toEqual(new Uint8Array([42]));
    expect(unzipFiles(new Uint8Array())).toEqual(mockFiles);
  });

  it("resets to default when passed null", () => {
    setArchiveIO({
      zip: () => { throw new Error("should not be called"); },
      unzip: () => { throw new Error("should not be called"); },
    });
    setArchiveIO(null);

    // Default implementation should work
    const input: FileMap = { "test.txt": "reset works" };
    const zipped = zipFiles(input);
    expect(zipped).not.toBeNull();
    expect(unzipFiles(zipped!)).toEqual(input);
  });
});
