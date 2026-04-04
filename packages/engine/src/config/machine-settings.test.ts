import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { loadMachineSettings, saveMachineSettings } from "./machine-settings.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadMachineSettings", () => {
  it("returns defaults when file is missing", () => {
    mockRead.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(loadMachineSettings("/tmp")).toEqual({ devModeEnabled: false });
  });

  it("returns defaults when file is corrupt", () => {
    mockRead.mockReturnValue("not json" as never);
    expect(loadMachineSettings("/tmp")).toEqual({ devModeEnabled: false });
  });

  it("loads saved settings", () => {
    mockRead.mockReturnValue(JSON.stringify({ devModeEnabled: true }) as never);
    expect(loadMachineSettings("/tmp")).toEqual({ devModeEnabled: true });
  });

  it("rejects non-boolean devModeEnabled", () => {
    mockRead.mockReturnValue(JSON.stringify({ devModeEnabled: "yes" }) as never);
    expect(loadMachineSettings("/tmp")).toEqual({ devModeEnabled: false });
  });
});

describe("saveMachineSettings", () => {
  it("writes JSON to the correct path", () => {
    saveMachineSettings("/tmp/cfg", { devModeEnabled: true });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.stringContaining("machine-settings.json"),
      expect.stringContaining('"devModeEnabled": true'),
      "utf-8",
    );
  });
});
