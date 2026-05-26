import { describe, it, expect } from "vitest";
import { TurnCollector, CodexTurnFailedError, messageToResponsesItems } from "./provider.js";
import type {
  AgentMessageDeltaNotification, ItemCompletedNotification,
  TurnCompletedNotification, RawResponseItemCompletedNotification,
} from "./protocol.js";
import type { NormalizedMessage } from "../types.js";

function completedTurn(): TurnCompletedNotification {
  return {
    threadId: "t1",
    turn: { id: "turn_1", status: "completed", durationMs: 100 },
  } as TurnCompletedNotification;
}

function agentMessageCompleted(text: string): ItemCompletedNotification {
  return {
    threadId: "t1",
    item: { id: "msg_1", type: "agentMessage", text },
  } as ItemCompletedNotification;
}

function agentMessageDelta(delta: string): AgentMessageDeltaNotification {
  return { threadId: "t1", itemId: "msg_1", delta } as AgentMessageDeltaNotification;
}

describe("TurnCollector", () => {
  it("records assistant text from streaming deltas", () => {
    const c = new TurnCollector();
    c.onAgentMessageDelta(agentMessageDelta("Hello, "));
    c.onAgentMessageDelta(agentMessageDelta("world."));
    c.onItemCompleted(agentMessageCompleted("Hello, world."));
    const result = c.toChatResult(completedTurn());

    expect(result.text).toBe("Hello, world.");
    expect(result.assistantContent).toEqual([{ type: "text", text: "Hello, world." }]);
    expect(result.toolCalls).toEqual([]);
  });

  // Codex owns tool dispatch end-to-end. The bridge must not see surfaced
  // tool calls or it re-runs every handler (the route-0 data corruption).
  it("never surfaces tool calls through ChatResult.toolCalls", () => {
    const c = new TurnCollector();
    c.onToolCall({ id: "call_1", name: "write_entity", input: { name: "Janey" } });
    const result = c.toChatResult(completedTurn());

    expect(result.toolCalls).toEqual([]);
    // But the assistant message still records what the model did, so
    // downstream history reflects it.
    expect(result.assistantContent).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: "write_entity",
      input: { name: "Janey" },
    });
  });

  // Copilot regression on #481: an agentMessage that completes AFTER a
  // tool_use in the same turn used to vanish, because the old branch
  // only updated/appended text when the last block was text or the array
  // was empty. tool_use as the last block silently dropped the prose.
  it("appends final prose as a new text block when it arrives after a tool_use", () => {
    const c = new TurnCollector();
    c.onToolCall({ id: "call_1", name: "write_entity", input: {} });
    c.onAgentMessageDelta(agentMessageDelta("Done."));
    c.onItemCompleted(agentMessageCompleted("Done."));
    const result = c.toChatResult(completedTurn());

    expect(result.text).toBe("Done.");
    expect(result.assistantContent).toEqual([
      { type: "tool_use", id: "call_1", name: "write_entity", input: {} },
      { type: "text", text: "Done." },
    ]);
  });

  it("updates the existing text block in place when prose precedes the tool_use", () => {
    const c = new TurnCollector();
    c.onAgentMessageDelta(agentMessageDelta("Pre"));
    c.onAgentMessageDelta(agentMessageDelta("amble."));
    c.onItemCompleted(agentMessageCompleted("Preamble."));
    c.onToolCall({ id: "call_1", name: "write_entity", input: {} });
    const result = c.toChatResult(completedTurn());

    expect(result.assistantContent).toEqual([
      { type: "text", text: "Preamble." },
      { type: "tool_use", id: "call_1", name: "write_entity", input: {} },
    ]);
  });

  it("falls back to completed item text when no deltas streamed", () => {
    const c = new TurnCollector();
    c.onItemCompleted(agentMessageCompleted("Non-streamed reply."));
    const result = c.toChatResult(completedTurn());

    expect(result.text).toBe("Non-streamed reply.");
    expect(result.assistantContent).toEqual([{ type: "text", text: "Non-streamed reply." }]);
  });
});

// ---------------------------------------------------------------------------
// Encrypted reasoning capture + replay (issue #533)
// ---------------------------------------------------------------------------

function rawReasoning(overrides: Partial<RawResponseItemCompletedNotification["item"]> & { id: string }): RawResponseItemCompletedNotification {
  return {
    threadId: "t1",
    turnId: "turn_1",
    item: { type: "reasoning", ...overrides },
  };
}

describe("TurnCollector: encrypted reasoning capture", () => {
  it("captures reasoning items carrying encrypted_content into assistantContent", () => {
    // The opaque blob has to round-trip on the next turn so the model can
    // continue reasoning from where it left off. Mirrors the openai-apikey
    // pattern in openai.ts (encryptedReasoningById).
    const c = new TurnCollector();
    c.onRawResponseItem(rawReasoning({
      id: "rs_1",
      encrypted_content: "enc-blob-1",
      summary: [{ type: "summary_text", text: "Weighing options." }],
    }));
    c.onAgentMessageDelta(agentMessageDelta("Onward."));
    c.onItemCompleted(agentMessageCompleted("Onward."));
    const result = c.toChatResult(completedTurn());

    expect(result.text).toBe("Onward.");
    expect(result.assistantContent).toEqual([
      { type: "text", text: "Onward." },
      { type: "reasoning", id: "rs_1", encryptedContent: "enc-blob-1", summary: ["Weighing options."] },
    ]);
  });

  it("skips reasoning items without an encrypted_content blob", () => {
    // ZDR-off / non-ZDR codex configurations don't forward the blob.
    // Persisting an empty shell would replay back as an invalid input
    // item, so we drop the item entirely.
    const c = new TurnCollector();
    c.onRawResponseItem(rawReasoning({ id: "rs_1", encrypted_content: null, summary: [] }));
    c.onItemCompleted(agentMessageCompleted("Hi."));
    const result = c.toChatResult(completedTurn());

    expect(result.assistantContent.some((p) => p.type === "reasoning")).toBe(false);
  });

  it("ignores non-reasoning raw items", () => {
    // Codex emits rawResponseItem/completed for every Responses-API item
    // type (message, function_call, …). Only reasoning carries the blob
    // we care about — everything else flows through item/completed.
    const c = new TurnCollector();
    c.onRawResponseItem({
      threadId: "t1",
      turnId: "turn_1",
      item: { type: "message", id: "msg_x", content: "ignored" },
    });
    c.onItemCompleted(agentMessageCompleted("Hello."));
    const result = c.toChatResult(completedTurn());

    expect(result.assistantContent).toEqual([{ type: "text", text: "Hello." }]);
  });

  it("dedupes encrypted reasoning by item id (last-write-wins)", () => {
    // Codex shouldn't emit the same id twice but if it did (retry,
    // reconnect), replaying duplicate items on the next turn would
    // have the Responses API reject the request for duplicate ids.
    const c = new TurnCollector();
    c.onRawResponseItem(rawReasoning({ id: "rs_1", encrypted_content: "enc-first", summary: [] }));
    c.onRawResponseItem(rawReasoning({ id: "rs_1", encrypted_content: "enc-second", summary: [] }));
    c.onItemCompleted(agentMessageCompleted("Done."));
    const result = c.toChatResult(completedTurn());

    const reasoningParts = result.assistantContent.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect(reasoningParts[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encryptedContent: "enc-second",
      summary: [],
    });
  });
});

describe("messageToResponsesItems: reasoning replay (issue #533)", () => {
  it("emits reasoning items at the head of the assistant turn", () => {
    // The Responses API requires reasoning items to precede the
    // message/function_call items they reason about. Even if they're
    // stored last in assistantContent (e.g. streaming append order),
    // they must be emitted first.
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Onward." },
        { type: "reasoning", id: "rs_1", encryptedContent: "enc-1", summary: ["Pondered."] },
        { type: "tool_use", id: "call_1", name: "roll_dice", input: { sides: 20 } },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc-1",
      summary: [{ type: "summary_text", text: "Pondered." }],
    });
    expect(items[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Onward." }],
    });
    expect(items[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "roll_dice",
      arguments: JSON.stringify({ sides: 20 }),
    });
  });

  it("preserves relative order of multiple reasoning items", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", id: "rs_a", encryptedContent: "enc-a", summary: [] },
        { type: "reasoning", id: "rs_b", encryptedContent: "enc-b", summary: [] },
        { type: "text", text: "Hi." },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect((items[0] as { id: string }).id).toBe("rs_a");
    expect((items[1] as { id: string }).id).toBe("rs_b");
  });

  it("drops Anthropic thinking blocks (codex would reject them on input)", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "thinking", text: "ignored", signature: "sig" },
        { type: "redacted_thinking", data: "also-ignored" },
        { type: "text", text: "Hi." },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi." }] },
    ]);
  });
});

describe("CodexTurnFailedError", () => {
  it("carries the codex error message in both the field and the message", () => {
    const err = new CodexTurnFailedError("model 'gpt-5.5' not found", "019e60e8-91ad");
    expect(err.codexMessage).toBe("model 'gpt-5.5' not found");
    expect(err.turnId).toBe("019e60e8-91ad");
    expect(err.message).toContain("019e60e8-91ad");
    expect(err.message).toContain("model 'gpt-5.5' not found");
    expect(err.name).toBe("CodexTurnFailedError");
    expect(err).toBeInstanceOf(Error);
  });

  it("falls back to a placeholder when codex provides no message", () => {
    // The throw site uses "(no error message from codex)" if turn.error is null.
    // This test guards against the constructor itself swallowing the input.
    const err = new CodexTurnFailedError("(no error message from codex)", "t_abc");
    expect(err.codexMessage).toBe("(no error message from codex)");
  });
});
