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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadClientSettings, saveClientSettings } from "./client-settings.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadClientSettings", () => {
  it("returns defaults when file is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: false });
  });

  it("returns defaults when file is corrupt", async () => {
    mockReadFile.mockResolvedValue("not json" as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: false });
  });

  it("loads saved settings", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ showVerbose: true }) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: true });
  });

  it("fills in missing keys with defaults", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({}) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: false });
  });

  it("rejects non-boolean values and falls back to defaults", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ showVerbose: 1 }) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: false });
  });

  it("ignores legacy devModeEnabled field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ devModeEnabled: true, showVerbose: true }) as never);
    const settings = await loadClientSettings();
    expect(settings).toEqual({ showVerbose: true });
    expect(settings).not.toHaveProperty("devModeEnabled");
  });
});

describe("saveClientSettings", () => {
  it("creates config directory and writes JSON", async () => {
    await saveClientSettings({ showVerbose: false });
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/test-config", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("client-settings.json"),
      expect.stringContaining('"showVerbose": false'),
      "utf-8",
    );
  });
});
