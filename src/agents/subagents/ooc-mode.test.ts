import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildOOCPrompt, enterOOC } from "./ooc-mode.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => responses[callIdx++]),
      })),
    },
  } as unknown as Anthropic;
}

describe("buildOOCPrompt", () => {
  it("includes campaign name", () => {
    const prompt = buildOOCPrompt("Shadow of the Dragon");
    expect(prompt).toContain("Campaign: Shadow of the Dragon");
  });

  it("includes rules and character sheet when provided", () => {
    const prompt = buildOOCPrompt("TestCampaign", "FATE rules here", "Aldric the Bold");
    expect(prompt).toContain("Game system rules:\nFATE rules here");
    expect(prompt).toContain("Active character:\nAldric the Bold");
  });

  it("omits optional blocks when absent", () => {
    const prompt = buildOOCPrompt("TestCampaign");
    expect(prompt).not.toContain("Game system rules:");
    expect(prompt).not.toContain("Active character:");
    expect(prompt).not.toContain("undefined");
  });
});

describe("enterOOC", () => {
  it("returns summary from first sentence", async () => {
    const client = mockClient([textResponse("Grappling lets you restrain foes. You need a STR check.")]);
    const result = await enterOOC(client, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("Grappling lets you restrain foes.");
  });

  it("truncates summary over 100 chars", async () => {
    const longText = "A".repeat(110) + ". More text here.";
    const client = mockClient([textResponse(longText)]);
    const result = await enterOOC(client, "Tell me everything", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toHaveLength(100);
    expect(result.summary).toMatch(/\.\.\.$/);
  });

  it("defaults summary for text without sentence boundary", async () => {
    const client = mockClient([textResponse("")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("OOC discussion.");
  });

  it("preserves snapshot with previousVariant and wasMidNarration", async () => {
    const client = mockClient([textResponse("Sure thing.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "narrating",
      wasMidNarration: true,
    });
    expect(result.snapshot.previousVariant).toBe("narrating");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("defaults wasMidNarration to false", async () => {
    const client = mockClient([textResponse("Ok.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.snapshot.wasMidNarration).toBe(false);
  });

  it("uses stream when onStream callback provided", async () => {
    const client = mockClient([textResponse("Response.")]);
    const onStream = vi.fn();
    await enterOOC(client, "question", {
      campaignName: "Test",
      previousVariant: "playing",
    }, onStream);
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("accumulates usage stats", async () => {
    const client = mockClient([textResponse("Done.")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });
});
