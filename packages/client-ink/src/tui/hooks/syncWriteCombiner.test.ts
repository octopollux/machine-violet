import { describe, it, expect, vi, beforeEach } from "vitest";
import { installSyncWriteCombiner } from "./syncWriteCombiner.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

function makeStream() {
  const writes: string[] = [];
  const stream = {
    write: vi.fn((data: unknown) => {
      writes.push(typeof data === "string" ? data : String(data));
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("installSyncWriteCombiner", () => {
  let stream: NodeJS.WriteStream;
  let writes: string[];
  let uninstall: () => void;

  beforeEach(() => {
    ({ stream, writes } = makeStream());
    uninstall = installSyncWriteCombiner(stream);
  });

  it("passes through writes that contain no BSU/ESU", () => {
    stream.write("hello");
    stream.write("world");
    expect(writes).toEqual(["hello", "world"]);
  });

  it("combines BSU → content → ESU into a single write", () => {
    stream.write(BSU);
    stream.write("content");
    stream.write(ESU);
    // All three should arrive as one combined write
    expect(writes).toEqual([BSU + "content" + ESU]);
  });

  it("combines BSU → multiple content chunks → ESU", () => {
    stream.write(BSU);
    stream.write("part1");
    stream.write("part2");
    stream.write("part3");
    stream.write(ESU);
    expect(writes).toEqual([BSU + "part1" + "part2" + "part3" + ESU]);
  });

  it("passes through when BSU and ESU are in the same chunk", () => {
    const allInOne = BSU + "content" + ESU;
    stream.write(allInOne);
    expect(writes).toEqual([allInOne]);
  });

  it("returns true for buffered writes", () => {
    expect(stream.write(BSU)).toBe(true);
    expect(stream.write("content")).toBe(true);
    expect(stream.write(ESU)).toBe(true);
  });

  it("handles multiple BSU/ESU blocks sequentially", () => {
    stream.write(BSU);
    stream.write("first");
    stream.write(ESU);

    stream.write("between-blocks");

    stream.write(BSU);
    stream.write("second");
    stream.write(ESU);

    expect(writes).toEqual([
      BSU + "first" + ESU,
      "between-blocks",
      BSU + "second" + ESU,
    ]);
  });

  it("uninstall restores the original write function", () => {
    uninstall();
    stream.write(BSU);
    stream.write("content");
    stream.write(ESU);
    // After uninstall, each write goes through individually
    expect(writes).toEqual([BSU, "content", ESU]);
  });

  it("handles BSU embedded within a larger chunk", () => {
    stream.write("prefix" + BSU);
    stream.write("content");
    stream.write(ESU);
    expect(writes).toEqual(["prefix" + BSU + "content" + ESU]);
  });
});
