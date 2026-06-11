import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { configDir, resetConfigDir } from "./paths.js";

describe("configDir MV_CONFIG_DIR override", () => {
  afterEach(() => {
    delete process.env.MV_CONFIG_DIR;
    resetConfigDir();
  });

  it("honors MV_CONFIG_DIR over default resolution, resolved to absolute", () => {
    resetConfigDir();
    process.env.MV_CONFIG_DIR = "some/rel/dir";
    expect(configDir()).toBe(resolve("some/rel/dir"));
  });

  it("caches the resolved dir until resetConfigDir()", () => {
    resetConfigDir();
    process.env.MV_CONFIG_DIR = "a";
    const first = configDir();
    process.env.MV_CONFIG_DIR = "b";
    expect(configDir()).toBe(first); // still cached — env change ignored
    resetConfigDir();
    expect(configDir()).toBe(resolve("b"));
  });
});
