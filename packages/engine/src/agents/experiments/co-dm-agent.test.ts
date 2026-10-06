import { ContinuingCoDmAgent } from "./co-dm-agent.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { loadModelConfig } from "../../config/models.js";
import type { LLMProvider, ChatParams } from "../../providers/types.js";

describe("continuing co-DM provider context", () => {
  beforeEach(() => { resetPromptCache(); loadModelConfig({ reset: true }); });
  it("keeps ordered conversation on the real loop and resumes its frozen prefix", async () => {
    const calls: ChatParams[] = [];
    const provider: LLMProvider = {
      name: "scripted-co-dm",
      chat: vi.fn(async params => {
        calls.push(structuredClone(params));
        return { text: "Useful correction", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      }),
    } as unknown as LLMProvider;
    const agent = new ContinuingCoDmAgent({ provider, frozenContext: "frozen-tree-v1", toolHandler: async () => ({ content: "ok" }) });
    await agent.run([{ id: "first", events: ["player", "tool", "narration"] }]);
    await agent.run([{ id: "second", events: ["annotation", "narration"] }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("gpt-6.1-sol");
    expect(calls[1].messages).toHaveLength(3);
    expect(calls[1].messages[0].content).toContain("first");
    expect(calls[1].messages[2].content).toContain("second");
    expect(calls[1].systemPrompt).toEqual(calls[0].systemPrompt);
    const restored = new ContinuingCoDmAgent({ provider, frozenContext: "frozen-tree-v1", messages: agent.getMessages(), toolHandler: async () => ({ content: "ok" }) });
    await restored.run([{ id: "third" }]);
    expect(calls[2].messages).toHaveLength(5);
    restored.reset("frozen-tree-v2");
    await restored.run([{ id: "new-scene" }]);
    expect(calls[3].messages).toHaveLength(1);
    expect(JSON.stringify(calls[3].systemPrompt)).toContain("frozen-tree-v2");
  });
});
