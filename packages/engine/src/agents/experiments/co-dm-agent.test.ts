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


it('compacts a long single-scene history after invalid ordinary output without dropping directives', async () => {
  let calls = 0; const requests: ChatParams[] = [];
  const provider = { providerId: 'long-scene', getCapabilities: () => ({ tools: true }), chat: vi.fn(async (params: ChatParams) => {
    requests.push(params); const text = calls++ === 0 ? 'freeform ordinary feedback' : JSON.stringify({ continuity: 'k0007 unresolved private directive remains pending' });
    return { text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }, assistantContent: [{ type: 'text', text }] };
  }) } as unknown as LLMProvider;
  const agent = new ContinuingCoDmAgent({ provider, frozenContext: 'immutable scene prefix', continuity: 'older unresolved task', messages: [{ role: 'user', content: 'private directive ' + 'x'.repeat(100_000) }], toolHandler: async () => ({ content: 'ok' }) });
  const result = await agent.run([{ id: 'long-scene-observation' }]);
  expect(result.continuity).toContain('unresolved private directive'); expect(agent.getMessages()).toEqual([]);
  expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1].messages)).toContain('private directive');
  expect(JSON.stringify(requests[0].systemPrompt)).toContain('immutable scene prefix');
});
