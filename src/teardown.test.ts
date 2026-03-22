import { describe, it, expect, vi, beforeEach } from "vitest";
import { teardownGameSession, resetAllCaches, RollbackCompleteError } from "./teardown.js";

// Mock all cache modules
vi.mock("./shutdown.js", () => ({
  gracefulShutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./prompts/load-prompt.js", () => ({
  resetPromptCache: vi.fn(),
}));

vi.mock("./tui/themes/index.js", () => ({
  resetThemeCache: vi.fn(),
}));

vi.mock("./config/dev-mode.js", () => ({
  resetDevMode: vi.fn(),
}));

vi.mock("./config/context-dump.js", () => ({
  resetContextDump: vi.fn(),
}));

vi.mock("./config/models.js", () => ({
  loadModelConfig: vi.fn(),
  loadPricingConfig: vi.fn(),
}));

import { gracefulShutdown } from "./shutdown.js";
import { resetPromptCache } from "./prompts/load-prompt.js";
import { resetThemeCache } from "./tui/themes/index.js";
import { resetDevMode } from "./config/dev-mode.js";
import { resetContextDump } from "./config/context-dump.js";
import { loadModelConfig, loadPricingConfig } from "./config/models.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teardownGameSession", () => {
  it("calls gracefulShutdown and resets all caches", async () => {
    const ctx = {};
    await teardownGameSession(ctx);

    expect(gracefulShutdown).toHaveBeenCalledWith(ctx);
    expect(resetPromptCache).toHaveBeenCalled();
    expect(resetThemeCache).toHaveBeenCalled();
    expect(resetDevMode).toHaveBeenCalled();
    expect(resetContextDump).toHaveBeenCalled();
    expect(loadModelConfig).toHaveBeenCalledWith({ reset: true });
    expect(loadPricingConfig).toHaveBeenCalledWith({ reset: true });
  });
});

describe("resetAllCaches", () => {
  it("resets all module-level caches", () => {
    resetAllCaches();

    expect(resetPromptCache).toHaveBeenCalled();
    expect(resetThemeCache).toHaveBeenCalled();
    expect(resetDevMode).toHaveBeenCalled();
    expect(resetContextDump).toHaveBeenCalled();
    expect(loadModelConfig).toHaveBeenCalledWith({ reset: true });
    expect(loadPricingConfig).toHaveBeenCalledWith({ reset: true });
  });
});

describe("RollbackCompleteError", () => {
  it("is an Error with name and summary", () => {
    const err = new RollbackCompleteError("rolled back to checkpoint X");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RollbackCompleteError");
    expect(err.summary).toBe("rolled back to checkpoint X");
    expect(err.message).toContain("rolled back to checkpoint X");
  });
});
