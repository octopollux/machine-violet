import { copyToClipboard, readFromClipboard, setClipboardIO } from "./clipboard.js";
import type { ClipboardIO } from "./clipboard.js";

let written: string[];

function mockClipboardIO(): ClipboardIO {
  return {
    write: async (text: string) => { written.push(text); },
    read: async () => written[written.length - 1] ?? "",
  };
}

beforeEach(() => {
  written = [];
  setClipboardIO(mockClipboardIO());
});

afterEach(() => {
  setClipboardIO(null);
});

describe("copyToClipboard", () => {
  it("writes text and returns true", async () => {
    const ok = await copyToClipboard("hello");
    expect(ok).toBe(true);
    expect(written).toEqual(["hello"]);
  });

  it("handles multiple writes", async () => {
    await copyToClipboard("first");
    await copyToClipboard("second");
    expect(written).toEqual(["first", "second"]);
  });

  it("returns false when write fails", async () => {
    setClipboardIO({
      write: async () => { throw new Error("no clipboard"); },
      read: async () => "",
    });
    const ok = await copyToClipboard("fail");
    expect(ok).toBe(false);
  });
});

describe("readFromClipboard", () => {
  it("reads the last written text", async () => {
    await copyToClipboard("clipboard content");
    const text = await readFromClipboard();
    expect(text).toBe("clipboard content");
  });

  it("returns empty string when nothing written", async () => {
    const text = await readFromClipboard();
    expect(text).toBe("");
  });

  it("returns empty string when read fails", async () => {
    setClipboardIO({
      write: async () => {},
      read: async () => { throw new Error("no clipboard"); },
    });
    const text = await readFromClipboard();
    expect(text).toBe("");
  });
});
