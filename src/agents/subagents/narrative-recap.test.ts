import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateNarrativeRecap } from "./narrative-recap.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 30, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
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

beforeEach(() => {
  resetPromptCache();
});

describe("generateNarrativeRecap", () => {
  it("returns narrative prose from bullet recap", async () => {
    const narrative = "Last time on Dragon's Crown, Kael ventured into the ruins beneath the old temple, discovering an ancient seal that pulsed with dark energy.";
    const client = mockClient([textResponse(narrative)]);

    const result = await generateNarrativeRecap(
      client,
      "- [[Kael]] entered the ruins\n- Found an ancient seal with dark energy",
      "Dragon's Crown",
    );

    expect(result.text).toContain("Last time on Dragon's Crown");
    expect(result.text).toContain("Kael");
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(40);
  });

  it("passes campaign name into the system prompt template", async () => {
    const client = mockClient([textResponse("Last time on Shadows of Edyn...")]);
    await generateNarrativeRecap(client, "- Stuff happened", "Shadows of Edyn");

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.system).toContain("Shadows of Edyn");
  });

  it("sends bullet recap as user message", async () => {
    const bullets = "- [[Mira]] betrayed the party\n- [[Corvin]] fled into the night";
    const client = mockClient([textResponse("Last time...")]);
    await generateNarrativeRecap(client, bullets, "Test Campaign");

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain(bullets);
  });
});
