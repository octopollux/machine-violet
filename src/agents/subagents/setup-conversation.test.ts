import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createSetupConversation } from "./setup-conversation.js";

function mockUsage(input = 50, output = 20): Anthropic.Usage {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textResponse(text: string, usage?: Anthropic.Usage): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage ?? mockUsage(),
  } as Anthropic.Message;
}

function presentChoicesResponse(text: string, prompt: string, choices: string[]): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text },
      {
        type: "tool_use",
        id: "toolu_choices_1",
        name: "present_choices",
        input: { prompt, choices },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function finalizeResponse(input: Record<string, unknown>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "toolu_finalize_1",
        name: "finalize_setup",
        input,
      },
    ],
    stop_reason: "tool_use",
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

const FINALIZE_INPUT = {
  genre: "Dark fantasy",
  system: null,
  campaign_name: "Shadows of Eldara",
  campaign_premise: "Darkness rises in the ancient kingdom.",
  mood: "Grimdark",
  difficulty: "Balanced",
  dm_personality: "The Chronicler",
  player_name: "Alex",
  character_name: "Kael",
  character_description: "A scarred ranger seeking redemption",
};

const noop = () => {};

describe("createSetupConversation", () => {
  it("start() returns opening text", async () => {
    const client = mockClient([textResponse("Welcome, brave soul!")]);
    const conv = createSetupConversation(client);
    const result = await conv.start(noop);
    expect(result.text).toBe("Welcome, brave soul!");
  });

  it("start() uses stream", async () => {
    const client = mockClient([textResponse("Welcome!")]);
    const conv = createSetupConversation(client);
    await conv.start(noop);
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("send() returns text response", async () => {
    const client = mockClient([
      textResponse("Welcome!"),
      textResponse("Great choice! Dark fantasy it is."),
    ]);
    const conv = createSetupConversation(client);
    await conv.start(noop);
    const result = await conv.send("I want dark fantasy", noop);
    expect(result.text).toBe("Great choice! Dark fantasy it is.");
  });

  it("present_choices returns pendingChoices", async () => {
    const client = mockClient([
      presentChoicesResponse(
        "What kind of world excites you?",
        "Choose your genre:",
        ["Classic Fantasy", "Sci-Fi", "Modern Supernatural"],
      ),
    ]);
    const conv = createSetupConversation(client);
    const result = await conv.start(noop);

    expect(result.pendingChoices).toBeDefined();
    expect(result.pendingChoices!.prompt).toBe("Choose your genre:");
    expect(result.pendingChoices!.choices).toEqual(["Classic Fantasy", "Sci-Fi", "Modern Supernatural"]);
  });

  it("resolveChoice() sends selection and gets follow-up", async () => {
    const client = mockClient([
      presentChoicesResponse("Pick one:", "Genre:", ["Fantasy", "Sci-Fi"]),
      textResponse("Fantasy it is! Now tell me about your character."),
    ]);
    const conv = createSetupConversation(client);
    await conv.start(noop);

    const result = await conv.resolveChoice("Fantasy", noop);
    expect(result.text).toBe("Fantasy it is! Now tell me about your character.");
  });

  it("resolveChoice() throws when no pending choice", async () => {
    const client = mockClient([textResponse("Hello!")]);
    const conv = createSetupConversation(client);
    await conv.start(noop);

    await expect(conv.resolveChoice("anything", noop)).rejects.toThrow("No pending choice to resolve");
  });

  it("finalize_setup populates finalized result", async () => {
    const client = mockClient([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Farewell, brave adventurer!"),
    ]);
    const conv = createSetupConversation(client);
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.campaignName).toBe("Shadows of Eldara");
    expect(result.finalized!.genre).toBe("Dark fantasy");
    expect(result.finalized!.characterName).toBe("Kael");
    expect(result.finalized!.playerName).toBe("Alex");
    expect(result.finalized!.difficulty).toBe("Balanced");
    expect(result.finalized!.personality.name).toBe("The Chronicler");
  });

  it("finalize_setup triggers farewell follow-up", async () => {
    const client = mockClient([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("May your blade stay sharp!"),
    ]);
    const conv = createSetupConversation(client);
    const result = await conv.start(noop);

    // Two stream calls: the finalize response + the farewell follow-up
    expect(client.messages.stream).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("May your blade stay sharp!");
  });

  it("send() after dismissed choice includes tool_result", async () => {
    const client = mockClient([
      presentChoicesResponse("Pick one:", "Genre:", ["Fantasy", "Sci-Fi"]),
      textResponse("Interesting! Tell me more about that."),
    ]);
    const conv = createSetupConversation(client);
    await conv.start(noop);

    // User dismisses the choice modal and types free-form text instead
    const result = await conv.send("I want a pirate adventure", noop);
    expect(result.text).toBe("Interesting! Tell me more about that.");

    // Verify the message sent to the API included a tool_result (not plain text)
    const streamCalls = (client.messages.stream as ReturnType<typeof vi.fn>).mock.calls;
    const secondCall = streamCalls[1][0];
    const userMsg = secondCall.messages.find(
      (m: { role: string }) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    expect(userMsg.content[0].type).toBe("tool_result");
    expect(userMsg.content[0].tool_use_id).toBe("toolu_choices_1");
    expect(userMsg.content[0].content).toContain("I want a pirate adventure");
  });

  it("usage accumulates across turns", async () => {
    const client = mockClient([
      textResponse("Welcome!", mockUsage(100, 30)),
      textResponse("Great!", mockUsage(80, 25)),
    ]);
    const conv = createSetupConversation(client);

    await conv.start(noop);
    const result = await conv.send("dark fantasy", noop);

    expect(result.usage.inputTokens).toBe(180);
    expect(result.usage.outputTokens).toBe(55);
  });
});
