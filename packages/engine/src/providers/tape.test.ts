import { describe, it, expect } from "vitest";
import type { ChatParams, ChatResult, NormalizedMessage, NormalizedUsage } from "./types.js";
import {
  TAPE_VERSION,
  TapeReader,
  TapeWriter,
  bucketOf,
  deserializeTape,
  fingerprint,
  serializeTape,
} from "./tape.js";

function usage(): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function result(text: string): ChatResult {
  return { text, toolCalls: [], usage: usage(), stopReason: "end", assistantContent: [{ type: "text", text }] };
}

function params(messages: NormalizedMessage[], conversationId?: string): ChatParams {
  return { model: "model-x", systemPrompt: "system prompt", messages, maxTokens: 100, conversationId };
}

describe("bucketOf", () => {
  it("uses conversationId, falling back to 'default'", () => {
    expect(bucketOf({ conversationId: "dm" })).toBe("dm");
    expect(bucketOf({ conversationId: undefined })).toBe("default");
  });
});

describe("fingerprint", () => {
  it("captures model, message count, sorted tools, and a last-message preview", () => {
    const fp = fingerprint({
      model: "m",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "first" }, { role: "user", content: "  the   last\nmessage " }],
      maxTokens: 50,
      tools: [{ name: "zebra", description: "", inputSchema: {} }, { name: "apple", description: "", inputSchema: {} }],
      dispatchTool: async () => ({ content: "" }),
    });
    expect(fp.model).toBe("m");
    expect(fp.messageCount).toBe(2);
    expect(fp.tools).toEqual(["apple", "zebra"]);
    expect(fp.lastMessagePreview).toBe("the last message");
    expect(fp.systemHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hashes the system prompt stably across calls", () => {
    const a = fingerprint(params([{ role: "user", content: "x" }]));
    const b = fingerprint(params([{ role: "user", content: "y" }]));
    expect(a.systemHash).toBe(b.systemHash); // same system → same hash
  });
});

describe("TapeWriter / TapeReader ordinals", () => {
  it("assigns independent ordinals per bucket", () => {
    const w = new TapeWriter("s");
    w.recordChat("dm", params([{ role: "user", content: "a" }], "dm"), result("dm0"));
    w.recordChat("scribe", params([{ role: "user", content: "b" }], "scribe"), result("scribe0"));
    w.recordChat("dm", params([{ role: "user", content: "c" }], "dm"), result("dm1"));

    const r = new TapeReader(w.build());
    expect(r.chatAt("dm", 0)?.result.text).toBe("dm0");
    expect(r.chatAt("dm", 1)?.result.text).toBe("dm1");
    expect(r.chatAt("scribe", 0)?.result.text).toBe("scribe0");
    expect(r.chatAt("dm", 2)).toBeUndefined();
  });
});

describe("serializeTape / deserializeTape", () => {
  it("round-trips a tape through JSON", () => {
    const w = new TapeWriter("round-trip");
    w.recordCapabilities("model-x", { imageGeneration: true });
    w.recordChat("dm", params([{ role: "user", content: "hello" }], "dm"), result("hi there"));
    const tape = w.build();

    const restored = deserializeTape(serializeTape(tape));
    expect(restored).toEqual(tape);
    expect(restored.version).toBe(TAPE_VERSION);
  });

  it("rejects an unknown tape version", () => {
    expect(() => deserializeTape(JSON.stringify({ version: 999, scenario: "x", capabilities: {}, entries: [] }))).toThrow(
      /Unsupported tape version/,
    );
  });
});
