import { describe, it, expect } from "vitest";
import { TurnCollector } from "./provider.js";
import type {
  AgentMessageDeltaNotification, ItemCompletedNotification,
  TurnCompletedNotification,
} from "./protocol.js";

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
