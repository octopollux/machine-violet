import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { trackScene, parseSceneTrackerResult, SCENE_TRACKER_CADENCE } from "./scene-tracker.js";
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

const mockUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  resetPromptCache();
});

describe("parseSceneTrackerResult", () => {
  it("parses well-formed THREADS and NPC_NEXT", () => {
    const result = parseSceneTrackerResult({
      text: "THREADS: [[Mira]]'s nervousness, [[Corvin]]'s offer\nNPC_NEXT: [[Mira]] intends to flee",
      usage: mockUsage,
    });
    expect(result.openThreads).toBe("[[Mira]]'s nervousness, [[Corvin]]'s offer");
    expect(result.npcIntents).toBe("[[Mira]] intends to flee");
  });

  it("handles (none) threads", () => {
    const result = parseSceneTrackerResult({
      text: "THREADS: (none)",
      usage: mockUsage,
    });
    expect(result.openThreads).toBe("");
    expect(result.npcIntents).toBeUndefined();
  });

  it("handles missing NPC_NEXT lines", () => {
    const result = parseSceneTrackerResult({
      text: "THREADS: [[quest-a]]",
      usage: mockUsage,
    });
    expect(result.openThreads).toBe("[[quest-a]]");
    expect(result.npcIntents).toBeUndefined();
  });

  it("joins multiple NPC_NEXT lines", () => {
    const result = parseSceneTrackerResult({
      text: "THREADS: [[quest-a]]\nNPC_NEXT: [[Mira]] intends to flee\nNPC_NEXT: [[Corvin]] intends to bargain",
      usage: mockUsage,
    });
    expect(result.npcIntents).toBe("[[Mira]] intends to flee; [[Corvin]] intends to bargain");
  });

  it("returns undefined threads on malformed output (preserves existing)", () => {
    const result = parseSceneTrackerResult({
      text: "I don't understand the format",
      usage: mockUsage,
    });
    expect(result.openThreads).toBeUndefined();
    expect(result.npcIntents).toBeUndefined();
  });

  it("handles empty THREADS value", () => {
    const result = parseSceneTrackerResult({
      text: "THREADS: ",
      usage: mockUsage,
    });
    expect(result.openThreads).toBe("");
  });
});

describe("trackScene", () => {
  const mockClient = {} as Anthropic;

  it("returns parsed threads from subagent response", async () => {
    vi.mocked(oneShot).mockResolvedValue({
      text: "THREADS: [[goblin-ambush]], [[missing-merchant]]",
      usage: mockUsage,
    });

    const result = await trackScene(mockClient, [
      "**[Aldric]:** I search the room.",
      "**DM:** You find a hidden compartment.",
    ]);
    expect(result.openThreads).toBe("[[goblin-ambush]], [[missing-merchant]]");
  });

  it("returns undefined threads on API failure (preserves existing)", async () => {
    vi.mocked(oneShot).mockRejectedValue(new Error("API error"));

    const result = await trackScene(mockClient, ["**[Aldric]:** Hello"]);
    expect(result.openThreads).toBeUndefined();
    expect(result.usage.inputTokens).toBe(0);
  });

  it("includes current threads in prompt", async () => {
    vi.mocked(oneShot).mockResolvedValue({ text: "THREADS: (none)", usage: mockUsage });

    await trackScene(mockClient, ["**[Aldric]:** I leave."], "[[quest-a]]", "[[Mira]] waits");

    const userMessage = vi.mocked(oneShot).mock.calls[0][3] as string;
    expect(userMessage).toContain("Current threads: [[quest-a]]");
    expect(userMessage).toContain("Current NPC intents: [[Mira]] waits");
  });

  it("truncates transcript to last 6 entries", async () => {
    vi.mocked(oneShot).mockResolvedValue({ text: "THREADS: (none)", usage: mockUsage });

    const longTranscript = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    await trackScene(mockClient, longTranscript);

    const userMessage = vi.mocked(oneShot).mock.calls[0][3] as string;
    expect(userMessage).not.toContain("line-0");
    expect(userMessage).toContain("line-4");
    expect(userMessage).toContain("line-9");
  });

  it("calls oneShot with correct model and name", async () => {
    vi.mocked(oneShot).mockResolvedValue({ text: "THREADS: (none)", usage: mockUsage });

    await trackScene(mockClient, ["test"]);

    expect(oneShot).toHaveBeenCalledWith(
      mockClient,
      "claude-haiku-4-5-20251001",
      expect.any(String),
      expect.any(String),
      128,
      "scene-tracker",
    );
  });
});

describe("SCENE_TRACKER_CADENCE", () => {
  it("is a positive integer", () => {
    expect(SCENE_TRACKER_CADENCE).toBeGreaterThan(0);
    expect(Number.isInteger(SCENE_TRACKER_CADENCE)).toBe(true);
  });
});
