import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import { generateNarrativeRecap } from "./narrative-recap.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

function mockUsage(): NormalizedUsage {
  return { inputTokens: 30, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResult(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function mockProvider(responses: ChatResult[]): LLMProvider {
  let callIdx = 0;
  return {
    providerId: "test",
    chat: vi.fn(async () => responses[callIdx++]),
    stream: vi.fn(async (_params, onDelta) => {
      const result = responses[callIdx++];
      if (result.text) onDelta(result.text);
      return result;
    }),
    healthCheck: vi.fn(),
  };
}

beforeEach(() => {
  resetPromptCache();
});

describe("generateNarrativeRecap", () => {
  it("returns narrative prose from bullet recap", async () => {
    const narrative = "Last time on Dragon's Crown, Kael ventured into the ruins beneath the old temple, discovering an ancient seal that pulsed with dark energy.";
    const provider = mockProvider([textResult(narrative)]);

    const result = await generateNarrativeRecap(
      provider,
      "- [[Kael]] entered the ruins\n- Found an ancient seal with dark energy",
      "Dragon's Crown",
      "claude-haiku-4-5-20251001",
    );

    expect(result.text).toContain("Last time on Dragon's Crown");
    expect(result.text).toContain("Kael");
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(40);
  });

  it("passes campaign name into the system prompt template", async () => {
    const provider = mockProvider([textResult("Last time on Shadows of Edyn...")]);
    await generateNarrativeRecap(provider, "- Stuff happened", "Shadows of Edyn", "claude-haiku-4-5-20251001");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemText = Array.isArray(call.systemPrompt)
      ? call.systemPrompt.map((b: { text: string }) => b.text).join("")
      : call.systemPrompt;
    expect(systemText).toContain("Shadows of Edyn");
  });

  it("sends bullet recap as user message", async () => {
    const bullets = "- [[Mira]] betrayed the party\n- [[Corvin]] fled into the night";
    const provider = mockProvider([textResult("Last time...")]);
    await generateNarrativeRecap(provider, bullets, "Test Campaign", "claude-haiku-4-5-20251001");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain(bullets);
  });
});
