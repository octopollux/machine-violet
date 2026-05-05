import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider } from "../../providers/types.js";
import { generateDiscordStatus } from "./discord-status.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

vi.mock("../subagent.js", () => ({
  oneShot: vi.fn(),
  spawnSubagent: vi.fn(),
  cacheSystemPrompt: vi.fn((s: string) => [{ type: "text", text: s, cache_control: { type: "ephemeral" } }]),
}));

vi.mock("../../config/models.js", () => ({
  getModel: vi.fn(() => "claude-haiku-4-5-20251001"),
  loadModelConfig: vi.fn(),
}));

const { oneShot } = await import("../subagent.js");

beforeEach(() => {
  vi.clearAllMocks();
  resetPromptCache();
});

describe("generateDiscordStatus", () => {
  // Provider is unused — `oneShot` is mocked at the module boundary, so the
  // tests never actually call into it. Cast satisfies the type signature.
  const mockClient = {} as unknown as LLMProvider;

  it("returns the subagent response trimmed to 40 chars", async () => {
    vi.mocked(oneShot).mockResolvedValue({
      text: "negotiating with a door",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const result = await generateDiscordStatus(mockClient, "The party approached the enchanted door.", "claude-haiku-4-5-20251001");
    expect(result.status).toBe("negotiating with a door");
    expect(result.usage?.inputTokens).toBe(100);
  });

  it("truncates long responses to 40 characters", async () => {
    vi.mocked(oneShot).mockResolvedValue({
      text: "a very long status line that exceeds the maximum character limit for discord",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const result = await generateDiscordStatus(mockClient, "context", "claude-haiku-4-5-20251001");
    expect(result.status.length).toBeLessThanOrEqual(40);
  });

  it("strips surrounding quotes from response", async () => {
    vi.mocked(oneShot).mockResolvedValue({
      text: '"technically alive"',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const result = await generateDiscordStatus(mockClient, "context", "claude-haiku-4-5-20251001");
    expect(result.status).toBe("technically alive");
  });

  it("returns fallback on API failure", async () => {
    vi.mocked(oneShot).mockRejectedValue(new Error("API error"));

    const result = await generateDiscordStatus(mockClient, "context", "claude-haiku-4-5-20251001");
    expect(result.status).toBe("Adventuring...");
    expect(result.usage).toBeNull();
  });

  it("returns fallback on empty response", async () => {
    vi.mocked(oneShot).mockResolvedValue({
      text: "   ",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    const result = await generateDiscordStatus(mockClient, "context", "claude-haiku-4-5-20251001");
    expect(result.status).toBe("Adventuring...");
  });
});
