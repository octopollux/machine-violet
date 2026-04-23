import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { estimateTokens, estimateMessageTokens } from "./token-counter.js";
import { ConversationManager } from "./conversation.js";
import { buildCachedPrefix } from "./prefix-builder.js";
import type { ContextConfig, CampaignConfig } from "@machine-violet/shared/types/config.js";

const defaultContextConfig: ContextConfig = {
  retention_exchanges: 100,
  max_conversation_tokens: 100_000,
  tool_result_stub_after: 5,
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

function assistantToolUseMsg(toolName: string, toolId: string): Anthropic.MessageParam {
  return {
    role: "assistant",
    content: [{
      type: "tool_use",
      id: toolId,
      name: toolName,
      input: {},
    } as Anthropic.ToolUseBlockParam],
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

  it("includes tool results in messages between user and assistant", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(
      userMsg("Roll"),
      assistantMsg("Rolling..."),
      [toolResultMsg("toolu_1", "1d20: [15]→20")],
    );
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(3);
    // Order: user → tool_result → assistant
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Roll");
    expect(messages[1].role).toBe("user"); // tool_result messages have role "user"
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Rolling...");
  });

  it("orders multi-round tool interactions correctly", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    const toolInteractions: Anthropic.MessageParam[] = [
      assistantToolUseMsg("roll_dice", "toolu_1"),
      toolResultMsg("toolu_1", "1d20: [15]→20"),
      assistantToolUseMsg("read_entity", "toolu_2"),
      toolResultMsg("toolu_2", "Goblin: HP 7"),
    ];
    mgr.addExchange(
      userMsg("Attack the goblin"),
      assistantMsg("You strike the goblin for 5 damage!"),
      toolInteractions,
    );
    const messages = mgr.getMessages();
    // user → 4 tool interactions → final assistant = 6 messages
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Attack the goblin");
    expect(messages[1].role).toBe("assistant"); // tool_use
    expect(messages[2].role).toBe("user"); // tool_result
    expect(messages[3].role).toBe("assistant"); // tool_use
    expect(messages[4].role).toBe("user"); // tool_result
    expect(messages[5].role).toBe("assistant");
    expect(messages[5].content).toBe("You strike the goblin for 5 damage!");
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

  it("does not drop exchanges when max_conversation_tokens is 0 (disabled)", () => {
    const config: ContextConfig = {
      retention_exchanges: 100,
      max_conversation_tokens: 0,
      tool_result_stub_after: 1,
    };
    const mgr = new ConversationManager(config);

    // Add large exchanges that would exceed any reasonable limit
    mgr.addExchange(userMsg("a".repeat(500)), assistantMsg("b".repeat(500)));
    const dropped = mgr.addExchange(userMsg("c".repeat(500)), assistantMsg("d".repeat(500)));

    expect(dropped).toBeNull();
    expect(mgr.size).toBe(2);
  });

  it("preserves full tool results in conversation (no stubbing)", () => {
    const mgr = new ConversationManager(defaultContextConfig);

    mgr.addExchange(
      userMsg("Roll"),
      assistantMsg("Rolling..."),
      [toolResultMsg("toolu_1", "1d20+5: [15]→20")],
    );

    // Add more exchanges — tool result should remain intact
    mgr.addExchange(userMsg("Next"), assistantMsg("Done."));
    mgr.addExchange(userMsg("Again"), assistantMsg("OK."));

    const messages = mgr.getMessages();
    const toolMsg = messages[1]; // tool_result between user and assistant
    const content = toolMsg.content as Anthropic.ToolResultBlockParam[];
    expect(content[0].content).toBe("1d20+5: [15]→20");
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

  it("getExchanges returns current exchanges", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(userMsg("Hello"), assistantMsg("Hi"));
    mgr.addExchange(userMsg("Attack"), assistantMsg("You swing"));

    const exchanges = mgr.getExchanges();
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].user.content).toBe("Hello");
    expect(exchanges[1].assistant.content).toBe("You swing");
  });

  it("seedExchanges restores conversation with recomputed tokens", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.seedExchanges([
      {
        user: userMsg("Search the room"),
        assistant: assistantMsg("You find a chest."),
        toolResults: [],
        estimatedTokens: 0, // intentionally wrong — should be recomputed

      },
    ]);

    expect(mgr.size).toBe(1);
    expect(mgr.getEstimatedTokens()).toBeGreaterThan(0);
    const messages = mgr.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Search the room");
    expect(messages[1].content).toBe("You find a chest.");
  });

  it("seedExchanges preserves tool results", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.seedExchanges([
      {
        user: userMsg("Roll"),
        assistant: assistantMsg("You rolled 15"),
        toolResults: [toolResultMsg("toolu_1", "1d20: [15]→20")],
        estimatedTokens: 0,

      },
    ]);

    const messages = mgr.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("user"); // tool_result
    const content = messages[1].content as Anthropic.ToolResultBlockParam[];
    expect(content[0].content).toBe("1d20: [15]→20");
  });

  it("popLastExchange removes and returns last exchange", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    mgr.addExchange(userMsg("First"), assistantMsg("Resp 1"));
    mgr.addExchange(userMsg("Second"), assistantMsg("Resp 2"));

    const popped = mgr.popLastExchange();
    expect(popped).not.toBeNull();
    expect(popped!.user.content).toBe("Second");
    expect(popped!.assistant.content).toBe("Resp 2");
    expect(mgr.size).toBe(1);
    // Remaining exchange is the first one
    const messages = mgr.getMessages();
    expect(messages[0].content).toBe("First");
  });

  it("popLastExchange returns null when empty", () => {
    const mgr = new ConversationManager(defaultContextConfig);
    expect(mgr.popLastExchange()).toBeNull();
  });

  it("seeded exchanges participate in normal retention", () => {
    const config: ContextConfig = { ...defaultContextConfig, retention_exchanges: 2 };
    const mgr = new ConversationManager(config);

    // Seed one exchange
    mgr.seedExchanges([
      {
        user: userMsg("Old input"),
        assistant: assistantMsg("Old response"),
        toolResults: [],
        estimatedTokens: 0,

      },
    ]);

    // Add two more — should drop the seeded one
    mgr.addExchange(userMsg("New 1"), assistantMsg("Resp 1"));
    const dropped = mgr.addExchange(userMsg("New 2"), assistantMsg("Resp 2"));

    expect(mgr.size).toBe(2);
    expect(dropped).not.toBeNull();
    expect(dropped!.exchange.user.content).toBe("Old input");
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
    choices: { campaign_default: "never", player_overrides: {} },
  };

  it("builds prefix with all sections", () => {
    const { system, volatile } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the Dungeon Master.",
      personality: "You are terse and ominous.",
      rulesAppendix: "## Combat\nRoll d20 + modifier.",
      campaignSummary: "Scene 1: Party entered dungeon.",
      sessionRecap: "Last time, the party fought goblins.",
      activeState: "Location: Throne Room. Aldric: 28/42 HP.",
      scenePrecis: "Round 3 of combat. Two goblins remain.",
    });

    expect(system.length).toBeGreaterThan(0);
    expect(system[0].text).toContain("Dungeon Master");

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("terse and ominous");
    expect(allText).toContain("D&D 5e");
    expect(allText).toContain("Roll d20");
    expect(allText).toContain("Party entered dungeon");
    expect(allText).toContain("fought goblins");
    // Tier 3 content is in volatile, not system
    expect(volatile).toContain("Throne Room");
    expect(allText).toContain("Two goblins remain");
  });

  it("includes name inspiration as a Tier 2 block when present", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      nameInspiration: "Given names: Yui, Kwame, Ingrid\nFamily names: Petrov, Achebe, Bauer",
    });
    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("## Name Inspiration");
    expect(allText).toContain("Yui");
    expect(allText).toContain("Petrov");
  });

  it("omits empty sections", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Campaign Log");
    expect(allText).not.toContain("Scene So Far");
  });

  it("places BP1 on rules appendix when present", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      rulesAppendix: "Some rules.",
    });

    // Rules appendix (last Tier 1 block) should have cache_control (BP1)
    const rulesBlock = system.find((b) => b.text.includes("Rules Reference")) as unknown as Record<string, unknown>;
    expect(rulesBlock["cacheControl"]).toEqual({ ttl: "1h" });
  });

  it("falls back BP1 to last Tier 1 block when rulesAppendix is absent", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    // Without rules, BP1 falls back to the personality block (last Tier 1)
    const lastTier1 = system[system.length - 1] as unknown as Record<string, unknown>;
    expect(lastTier1["cacheControl"]).toEqual({ ttl: "1h" });
  });

  it("places BP2 on last Tier 2 block", () => {
    const { system, volatile } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      rulesAppendix: "Some rules.",
      sessionRecap: "Last time...",
      campaignSummary: "Scene 1.",
      scenePrecis: "Round 1.",
      playerRead: "Engagement: high",
      activeState: "Location: Tavern",
    });

    // playerRead is the last Tier 2 block — should have cache_control
    const playerReadBlock = system.find((b) => b.text.includes("Player Read")) as unknown as Record<string, unknown>;
    expect(playerReadBlock["cacheControl"]).toEqual({ ttl: "1h" });

    // Campaign summary should NOT have its own cache_control (BP2 is on playerRead)
    const summaryBlock = system.find((b) => b.text.includes("Campaign Log")) as unknown as Record<string, unknown>;
    expect(summaryBlock["cacheControl"]).toBeUndefined();

    // activeState (Tier 3) should be in volatile, not in system blocks
    expect(system.find((b) => b.text.includes("Current State"))).toBeUndefined();
    expect(volatile).toContain("Current State");
    expect(volatile).toContain("Location: Tavern");
  });

  it("places BP2 on campaign summary when it is the last Tier 2 block", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      campaignSummary: "Scene 1: Party entered dungeon.",
    });

    const summaryBlock = system.find((b) => b.text.includes("Campaign Log")) as unknown as Record<string, unknown>;
    expect(summaryBlock["cacheControl"]).toEqual({ ttl: "1h" });
  });

  it("includes Player Read block when provided", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      scenePrecis: "Round 1 of combat.",
      playerRead: "Engagement: high | Focus: combat | Tone: aggressive | Pacing: pushing_forward | Off-script: no",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("## Player Read");
    expect(allText).toContain("Engagement: high");
    expect(allText).toContain("Tone: aggressive");
  });

  it("omits Player Read block when not provided", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Player Read");
  });

  it("includes DM Notes block in Tier 2 when provided", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      dmNotes: "The innkeeper is a spy. Plot hook: missing merchant.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("## DM Notes");
    expect(allText).toContain("The innkeeper is a spy");
  });

  it("omits DM Notes block when not provided", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("DM Notes");
  });

  it("places BP2 on DM Notes when it is the last Tier 2 block", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      playerRead: "Engagement: high",
      dmNotes: "Secret plot info.",
    });

    const dmNotesBlock = system.find((b) => b.text.includes("DM Notes")) as unknown as Record<string, unknown>;
    expect(dmNotesBlock["cacheControl"]).toEqual({ ttl: "1h" });

    // playerRead should NOT have cache_control since dmNotes comes after
    const playerReadBlock = system.find((b) => b.text.includes("Player Read")) as unknown as Record<string, unknown>;
    expect(playerReadBlock["cacheControl"]).toBeUndefined();
  });

  it("does not include Scene Pacing block (removed from prefix)", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Scene Pacing");
  });

  it("Tier 3 content goes to volatile, not system blocks", () => {
    const { system, volatile } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      rulesAppendix: "Some rules.",
      sessionRecap: "Last time...",
      campaignSummary: "Scene 1.",
      scenePrecis: "Round 1.",
      playerRead: "Engagement: high",
      activeState: "Location: Tavern",
      entityIndex: "entity-list",
      uiState: "style=classic",
    });

    // System blocks should only contain Tier 1 + Tier 2
    const systemText = system.map((b) => b.text).join("\n");
    expect(systemText).toContain("Rules Reference");
    expect(systemText).toContain("Last Session");
    expect(systemText).toContain("Campaign Log");
    expect(systemText).toContain("Scene So Far");
    expect(systemText).toContain("Player Read");

    // Tier 3 is in volatile
    expect(systemText).not.toContain("Current State");
    expect(systemText).not.toContain("Entity Registry");
    expect(systemText).not.toContain("UI State");
    expect(volatile).toContain("Current State");
    expect(volatile).toContain("Location: Tavern");
    expect(volatile).toContain("Entity Registry");
    expect(volatile).toContain("entity-list");
    expect(volatile).toContain("UI State");
    expect(volatile).toContain("style=classic");
  });

  it("volatile is empty when no Tier 3 content provided", () => {
    const { volatile } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    expect(volatile).toBe("");
  });

  it("includes personality detail in personality block", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      personalityDetail: "Use weather as mood. Track motifs in DM notes.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("Your Personality");
    expect(allText).toContain("Terse.");
    expect(allText).toContain("Use weather as mood");
  });

  it("includes campaign detail in campaign setting block", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      campaignDetail: "Roll for variant: 1. THE PRETENDER 2. THE EMPTY THRONE",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("Campaign Detail");
    expect(allText).toContain("Roll for variant");
  });

  it("omits personality detail when undefined", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const personalityBlock = system.find((b) => b.text.includes("Your Personality"));
    expect(personalityBlock).toBeTruthy();
    // Should just have the personality text, no extra sections
    expect(personalityBlock!.text).not.toContain("\n\n\n");
  });

  it("omits campaign detail when undefined", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Campaign Detail");
  });

  it("omits personality detail when empty string", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      personalityDetail: "",
    });

    const personalityBlock = system.find((b) => b.text.includes("Your Personality"));
    expect(personalityBlock!.text).not.toContain("\n\n\n");
  });

  it("omits campaign detail when empty string", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      campaignDetail: "",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain("Campaign Detail");
  });

  it("renders campaign detail even without other setting fields", () => {
    const minimalConfig: CampaignConfig = {
      ...mockConfig,
      genre: undefined,
      mood: undefined,
      difficulty: undefined,
      premise: undefined,
      system: undefined,
    };
    const { system } = buildCachedPrefix(minimalConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      campaignDetail: "Secret variant instructions.",
    });

    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain("Campaign Detail");
    expect(allText).toContain("Secret variant instructions.");
  });

  it("emits personality between identity and directives so persona claims the seat before generic voice rules", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "IDENTITY_MARKER",
      dmDirectives: "DIRECTIVES_MARKER",
      personality: "PERSONALITY_MARKER",
    });

    const allText = system.map((b) => b.text).join("\n");
    const identityIdx = allText.indexOf("IDENTITY_MARKER");
    const personalityIdx = allText.indexOf("PERSONALITY_MARKER");
    const directivesIdx = allText.indexOf("DIRECTIVES_MARKER");

    expect(identityIdx).toBeGreaterThan(-1);
    expect(personalityIdx).toBeGreaterThan(-1);
    expect(directivesIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeLessThan(personalityIdx);
    expect(personalityIdx).toBeLessThan(directivesIdx);
  });

  it("places session recap before campaign summary in Tier 2", () => {
    const { system } = buildCachedPrefix(mockConfig, {
      dmIdentity: "You are the DM.",
      personality: "Terse.",
      rulesAppendix: "Some rules.",
      campaignSummary: "Scene 1: Party entered dungeon.",
      sessionRecap: "Last time, the party fought goblins.",
    });

    const recapIndex = system.findIndex((b) => b.text.includes("Last Session"));
    const summaryIndex = system.findIndex((b) => b.text.includes("Campaign Log"));
    expect(recapIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(recapIndex).toBeLessThan(summaryIndex);

    // BP2 should be on the last Tier 2 block (campaign summary in this case)
    const lastTier2 = system[summaryIndex] as unknown as Record<string, unknown>;
    expect(lastTier2["cacheControl"]).toEqual({ ttl: "1h" });
  });
});
