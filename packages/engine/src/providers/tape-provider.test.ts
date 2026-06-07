import { describe, it, expect, vi } from "vitest";
import type {
  ChatParams,
  ChatResult,
  GenerateImageResult,
  LLMProvider,
  NormalizedMessage,
  NormalizedUsage,
  ProviderCapabilities,
} from "./types.js";
import { TapeReader, TapeWriter, deserializeTape, serializeTape } from "./tape.js";
import { createReplayProvider, createTapingProvider } from "./tape-provider.js";

function usage(): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function result(text: string): ChatResult {
  return { text, toolCalls: [], usage: usage(), stopReason: "end", assistantContent: [{ type: "text", text }] };
}

function params(messages: NormalizedMessage[], conversationId?: string): ChatParams {
  return { model: "model-x", systemPrompt: "sys", messages, maxTokens: 100, conversationId };
}

function imageResult(): GenerateImageResult {
  return { base64: "AAAA", mimeType: "image/png", effortUsed: "draft", aspectUsed: "square" };
}

/** A fake inner provider whose outputs encode the input so we can assert routing. */
function fakeInner(): LLMProvider {
  return {
    providerId: "fake",
    getCapabilities: (_model): ProviderCapabilities => ({ imageGeneration: true }),
    chat: vi.fn(async (p: ChatParams) => result(`chat:${p.messages.length}`)),
    stream: vi.fn(async (_p: ChatParams, onDelta: (t: string) => void) => {
      onDelta("alpha");
      onDelta("beta");
      return result("streamed");
    }),
    healthCheck: vi.fn(async () => ({ status: "valid" as const, message: "ok" })),
    generateImage: vi.fn(async () => imageResult()),
  };
}

/** Record a representative session, then return a replay provider over the serialized tape. */
function recordThenReplay() {
  const inner = fakeInner();
  const writer = new TapeWriter("unit");
  const taping = createTapingProvider(inner, writer);
  return { inner, writer, taping, build: () => createReplayProvider(new TapeReader(deserializeTape(serializeTape(writer.build())))) };
}

describe("createTapingProvider", () => {
  it("forwards to the inner provider and records each interaction", async () => {
    const { inner, taping, writer } = recordThenReplay();

    expect(taping.getCapabilities("model-x")).toEqual({ imageGeneration: true });
    await taping.chat(params([{ role: "user", content: "a" }], "dm"));
    const deltas: string[] = [];
    await taping.stream(params([{ role: "user", content: "b" }], "dm"), (d) => deltas.push(d));

    expect(inner.chat).toHaveBeenCalledOnce();
    expect(inner.stream).toHaveBeenCalledOnce();
    expect(deltas).toEqual(["alpha", "beta"]); // deltas tee through to the caller

    const tape = writer.build();
    expect(tape.entries).toHaveLength(2);
    expect(tape.entries[1]).toMatchObject({ kind: "chat", bucket: "dm", ordinal: 1, streamDeltas: ["alpha", "beta"] });
    expect(tape.capabilities["model-x"]).toEqual({ imageGeneration: true });
  });

  it("only exposes generateImage when the inner provider does", () => {
    const withImages = createTapingProvider(fakeInner(), new TapeWriter("s"));
    expect(withImages.generateImage).toBeDefined();

    const noImageInner: LLMProvider = { ...fakeInner(), generateImage: undefined };
    const withoutImages = createTapingProvider(noImageInner, new TapeWriter("s"));
    expect(withoutImages.generateImage).toBeUndefined();
  });
});

describe("createReplayProvider", () => {
  it("replays recorded results deterministically with no inner provider", async () => {
    const rec = recordThenReplay();
    const r1 = await rec.taping.chat(params([{ role: "user", content: "a" }], "dm"));
    const sdeltas: string[] = [];
    const r2 = await rec.taping.stream(params([{ role: "user", content: "b" }], "scribe"), (d) => sdeltas.push(d));

    const replay = rec.build();
    expect(replay.getCapabilities("model-x")).toEqual({ imageGeneration: true });

    // Matching is by bucket + ordinal, so replay ignores request content.
    expect(await replay.chat(params([{ role: "user", content: "ANYTHING" }], "dm"))).toEqual(r1);
    const rdeltas: string[] = [];
    expect(await replay.stream(params([{ role: "user", content: "ELSE" }], "scribe"), (d) => rdeltas.push(d))).toEqual(r2);
    expect(rdeltas).toEqual(["alpha", "beta"]);
  });

  it("replays images in recorded order", async () => {
    const rec = recordThenReplay();
    await rec.taping.generateImage!({ prompt: "a portrait" });
    const replay = rec.build();
    expect(await replay.generateImage!({ prompt: "ignored" })).toEqual(imageResult());
  });

  it("throws a clear stale-tape error on a chat miss", async () => {
    const rec = recordThenReplay();
    await rec.taping.chat(params([{ role: "user", content: "only one" }], "dm"));
    const replay = rec.build();
    await replay.chat(params([{ role: "user", content: "x" }], "dm")); // ordinal 0 — ok
    await expect(replay.chat(params([{ role: "user", content: "y" }], "dm"))).rejects.toThrow(/Tape miss/);
  });

  it("reports no image-gen capability for an unrecorded model", () => {
    const replay = createReplayProvider(new TapeReader({ version: 1, scenario: "empty", capabilities: {}, entries: [] }));
    expect(replay.getCapabilities("unknown-model")).toEqual({ imageGeneration: false });
  });
});
