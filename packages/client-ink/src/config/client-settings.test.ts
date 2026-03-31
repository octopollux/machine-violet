import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and paths before importing the module
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/paths.js", () => ({
  configDir: () => "/tmp/test-config",
}));

import { readFile, writeFile } from "node:fs/promises";
import { loadClientSettings, saveClientSettings } from "./client-settings.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadClientSettings", () => {
  it("returns defaults when file is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const settings = await loadClientSettings();
    expect(settings).toEqual({ devModeEnabled: false, showVerbose: false });
  });

  it("returns defaults when file is corrupt", async () => {
    mockReadFile.mockResolvedValue("not json" as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ devModeEnabled: false, showVerbose: false });
  });

  it("loads saved settings", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ devModeEnabled: true, showVerbose: true }) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ devModeEnabled: true, showVerbose: true });
  });

  it("fills in missing keys with defaults", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ devModeEnabled: true }) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ devModeEnabled: true, showVerbose: false });
  });
});

describe("saveClientSettings", () => {
  it("writes JSON to the config directory", async () => {
    await saveClientSettings({ devModeEnabled: true, showVerbose: false });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("client-settings.json"),
      expect.stringContaining('"devModeEnabled": true'),
      "utf-8",
    );
  });
});
