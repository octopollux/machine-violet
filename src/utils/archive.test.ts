import { zipFiles, unzipFiles, setArchiveIO } from "./archive.js";
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

describe("zipFiles error handling", () => {
  it("returns null when zip throws", () => {
    setArchiveIO({
      zip: () => { throw new Error("boom"); },
      unzip: () => ({}),
    });
    expect(zipFiles({ "a.txt": "a" })).toBeNull();
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
