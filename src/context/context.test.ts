import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { estimateTokens, estimateMessageTokens } from "./token-counter.js";
import { ConversationManager } from "./conversation.js";
import { buildCachedPrefix } from "./prefix-builder.js";
import type { ContextConfig, CampaignConfig } from "../types/config.js";

const defaultContextConfig: ContextConfig = {
  retention_exchanges: 5,
  max_conversation_tokens: 8000,
  tool_result_stub_after: 2,
};

function userMsg(text: string): Anthropic.MessageParam {
  return { role: "user", content: text };
}

function assistantMsg(text: string): Anthropic.MessageParam {
  return { role: "assistant", content: text };
}

function toolResultMsg(toolUseId: string, content: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
    }],
  };
}

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2); // 5/4 = 1.25, ceil = 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateMessageTokens", () => {
  it("estimates string content", () => {
    const tokens = estimateMessageTokens(userMsg("Hello world"));
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("ConversationManager", () => {
  it("adds exchanges and generates messages", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(userMsg("Hello"), assistantMsg("Hi there!"));
    expect(mgr.size).toBe(1);
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("includes tool results in messages", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(
      userMsg("Roll"),
      assistantMsg("Rolling..."),
      [toolResultMsg("toolu_1", "1d20: [15]→20")],
    );
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(3);
  });

  it("drops oldest exchange when exceeding retention_exchanges", () => {
    const config: ContextConfig = { ...defaultContextConfig, retention_exchanges: 2 };
    const mgr = new ConversationManager(config);

    mgr.addExchange(userMsg("One"), assistantMsg("Resp 1"));
    mgr.addExchange(userMsg("Two"), assistantMsg("Resp 2"));
    const dropped = mgr.addExchange(userMsg("Three"), assistantMsg("Resp 3"));

    expect(mgr.size).toBe(2);
    expect(dropped).not.toBeNull();
    expect(dropped!.reason).toBe("exchange_count");
  });

  it("drops exchanges when exceeding max_conversation_tokens", () => {
    const config: ContextConfig = {
      retention_exchanges: 100,
      max_conversation_tokens: 50, // very small
      tool_result_stub_after: 1,
    };
    const mgr = new ConversationManager(config);

    // Add exchanges with enough text to exceed 50 tokens
    mgr.addExchange(userMsg("a".repeat(100)), assistantMsg("b".repeat(100)));
    const dropped = mgr.addExchange(userMsg("c".repeat(100)), assistantMsg("d".repeat(100)));

    // Should drop to stay under token limit (but keep at least 1)
    expect(dropped).not.toBeNull();
    expect(dropped!.reason).toBe("token_limit");
  });

  it("stubs old tool results", () => {
    const config: ContextConfig = { ...defaultContextConfig, tool_result_stub_after: 1 };
    const mgr = new ConversationManager(config);

    // First exchange with tool result
    mgr.addExchange(
      userMsg("Roll"),
      assistantMsg("Rolling..."),
      [toolResultMsg("toolu_1", "A very long tool result with lots of detail that should be stubbed")],
    );

    // Second exchange (triggers stubbing of first)
    mgr.addExchange(userMsg("Next"), assistantMsg("Done."));

    const messages = mgr.getMessages();
    // The tool result from the first exchange should be stubbed
    const toolMsg = messages[2]; // user, assistant, tool_result
    const content = toolMsg.content as Anthropic.ToolResultBlockParam[];
    expect(typeof content[0].content).toBe("string");
    expect((content[0].content as string)).toContain("[stub]");
  });

  it("clears all exchanges", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(userMsg("One"), assistantMsg("Resp 1"));
    mgr.addExchange(userMsg("Two"), assistantMsg("Resp 2"));
    mgr.clear();
    expect(mgr.size).toBe(0);
    expect(mgr.getMessages()).toHaveLength(0);
  });

  it("tracks estimated tokens", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(userMsg("Hello world"), assistantMsg("Hi there"));
    expect(mgr.getEstimatedTokens()).toBeGreaterThan(0);
  });
});

describe("buildCachedPrefix", () => {
  const mockConfig: CampaignConfig = {
    name: "Test Campaign",
    system: "D&D 5e",
    dm_personality: { name: "grim", prompt_fragment: "You are terse and ominous." },
    players: [{ name: "Alice", character: "Aldric", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: defaultContextConfig,
    recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
    choices: { campaign_default: "often", player_overrides: {} },
  };

  it("builds prefix with all sections", () => {
    const blocks = buildCachedPrefix(mockConfig, {
      dmPrompt: "You are the Dungeon Master.",
      personality: "You are terse and ominous.",
      rulesAppendix: "## Combat\nRoll d20 + modifier.",
      campaignSummary: "Scene 1: Party entered dungeon.",
      sessionRecap: "Last time, the party fought goblins.",
      activeState: "Location: Throne Room. Aldric: 28/42 HP.",
      scenePrecis: "Round 3 of combat. Two goblins remain.",
    });

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].text).toContain("Dungeon Master");

    const allText = blocks.map((b) => b.text).join("\n");
    expect(allText).toContain("terse and ominous");
    expect(allText).toContain("D&D 5e");
    expect(allText).toContain("Roll d20");
    expect(allText).toContain("Party entered dungeon");
    expect(allText).toContain("fought goblins");
    expect(allText).toContain("Throne Room");
    expect(allText).toContain("Two goblins remain");
  });

  it("omits empty sections", () => {
    const blocks = buildCachedPrefix(mockConfig, {
      dmPrompt: "You are the DM.",
      personality: "Terse.",
    });

    const allText = blocks.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Campaign Log");
    expect(allText).not.toContain("Scene So Far");
  });

  it("includes cache_control on stable sections", () => {
    const blocks = buildCachedPrefix(mockConfig, {
      dmPrompt: "You are the DM.",
      personality: "Terse.",
      rulesAppendix: "Some rules.",
    });

    // First block (DM prompt) should have cache_control
    const dmBlock = blocks[0] as Record<string, unknown>;
    expect(dmBlock["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("includes Player Read block when provided", () => {
    const blocks = buildCachedPrefix(mockConfig, {
      dmPrompt: "You are the DM.",
      personality: "Terse.",
      scenePrecis: "Round 1 of combat.",
      playerRead: "Engagement: high | Focus: combat | Tone: aggressive | Pacing: pushing_forward | Off-script: no",
    });

    const allText = blocks.map((b) => b.text).join("\n");
    expect(allText).toContain("## Player Read");
    expect(allText).toContain("Engagement: high");
    expect(allText).toContain("Tone: aggressive");
  });

  it("omits Player Read block when not provided", () => {
    const blocks = buildCachedPrefix(mockConfig, {
      dmPrompt: "You are the DM.",
      personality: "Terse.",
    });

    const allText = blocks.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Player Read");
  });
});
