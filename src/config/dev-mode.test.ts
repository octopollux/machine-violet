import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isDevMode, resetDevMode, wrapFileIOWithDevLog } from "./dev-mode.js";
import type { FileIO } from "../agents/scene-manager.js";

describe("isDevMode", () => {
  beforeEach(() => resetDevMode());
  afterEach(() => {
    delete process.env.DEV_MODE;
    resetDevMode();
  });

  it("returns false when DEV_MODE is not set", () => {
    delete process.env.DEV_MODE;
    expect(isDevMode()).toBe(false);
  });

  it("returns true when DEV_MODE is 'true'", () => {
    process.env.DEV_MODE = "true";
    expect(isDevMode()).toBe(true);
  });

  it("returns false for other values", () => {
    process.env.DEV_MODE = "1";
    expect(isDevMode()).toBe(false);
  });

  it("caches the result", () => {
    process.env.DEV_MODE = "true";
    expect(isDevMode()).toBe(true);
    process.env.DEV_MODE = "false";
    // Still cached as true
    expect(isDevMode()).toBe(true);
  });

  it("resets cache with resetDevMode", () => {
    process.env.DEV_MODE = "true";
    expect(isDevMode()).toBe(true);
    resetDevMode();
    process.env.DEV_MODE = "false";
    expect(isDevMode()).toBe(false);
  });
});

describe("wrapFileIOWithDevLog", () => {
  function makeMockIO(): FileIO {
    return {
      readFile: async () => "file content here",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
      exists: async () => true,
      listDir: async () => ["a.txt"],
    };
  }

  it("logs readFile with filename and size", async () => {
    const logs: string[] = [];
    const wrapped = wrapFileIOWithDevLog(makeMockIO(), (m) => logs.push(m));
    await wrapped.readFile("/some/path/entity.md");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[dev] file:read");
    expect(logs[0]).toContain("entity.md");
    expect(logs[0]).toContain("17 chars");
  });

  it("logs writeFile with filename and size", async () => {
    const logs: string[] = [];
    const wrapped = wrapFileIOWithDevLog(makeMockIO(), (m) => logs.push(m));
    await wrapped.writeFile("/some/path/out.json", "hello");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[dev] file:write");
    expect(logs[0]).toContain("out.json");
    expect(logs[0]).toContain("5 chars");
  });

  it("logs appendFile with filename and size", async () => {
    const logs: string[] = [];
    const wrapped = wrapFileIOWithDevLog(makeMockIO(), (m) => logs.push(m));
    await wrapped.appendFile("/x/log.txt", "ab");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[dev] file:append");
    expect(logs[0]).toContain("log.txt");
  });

  it("does not log mkdir, exists, or listDir", async () => {
    const logs: string[] = [];
    const wrapped = wrapFileIOWithDevLog(makeMockIO(), (m) => logs.push(m));
    await wrapped.mkdir("/dir");
    await wrapped.exists("/dir");
    await wrapped.listDir("/dir");
    expect(logs).toHaveLength(0);
  });

  it("handles backslash paths", async () => {
    const logs: string[] = [];
    const wrapped = wrapFileIOWithDevLog(makeMockIO(), (m) => logs.push(m));
    await wrapped.readFile("C:\\Users\\test\\file.md");
    expect(logs[0]).toContain("file.md");
  });
});
