import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatParams, ChatResult, LLMProvider, TierProvider } from "./types.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import { TapeWriter, serializeTape } from "./tape.js";
import {
  __resetTapeModeForTest,
  buildReplayTierProviders,
  getRecordedTape,
  replayActive,
  wrapForRecording,
} from "./tape-mode.js";

function result(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function fakeProvider(id: string): LLMProvider {
  return {
    providerId: id,
    getCapabilities: () => ({ imageGeneration: false }),
    chat: vi.fn(async () => result(`${id}-reply`)),
    stream: vi.fn(async () => result(`${id}-reply`)),
    healthCheck: vi.fn(async () => ({ status: "valid", message: "ok" })),
  };
}

function params(conversationId: string): ChatParams {
  return { model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10, conversationId };
}

function tiers(large: LLMProvider, medium: LLMProvider, small: LLMProvider): Record<ModelTier, TierProvider> {
  return { large: { provider: large, model: "L" }, medium: { provider: medium, model: "M" }, small: { provider: small, model: "S" } };
}

describe("tape-mode record wiring", () => {
  beforeEach(() => { __resetTapeModeForTest(); });
  afterEach(() => {
    delete process.env.MV_TAPE_MODE;
    delete process.env.MV_TAPE_SCENARIO;
    __resetTapeModeForTest();
  });

  it("is a pass-through no-op when MV_TAPE_MODE is not 'record'", () => {
    const t = tiers(fakeProvider("a"), fakeProvider("b"), fakeProvider("c"));
    expect(wrapForRecording(t)).toBe(t); // same object, untouched
    expect(getRecordedTape()).toBeNull();
  });

  it("tapes calls across tiers into one tape, deduping a shared provider", async () => {
    process.env.MV_TAPE_MODE = "record";
    process.env.MV_TAPE_SCENARIO = "unit";

    const large = fakeProvider("large");
    const shared = fakeProvider("shared");
    const w = wrapForRecording(tiers(large, shared, shared));

    // medium + small share one inner provider → one wrapper instance.
    expect(w.medium.provider).toBe(w.small.provider);
    expect(w.large.provider).not.toBe(w.medium.provider);

    await w.large.provider.chat(params("dm"));
    await w.medium.provider.chat(params("scribe"));

    const tape = getRecordedTape();
    expect(tape?.scenario).toBe("unit");
    expect(tape?.entries.map((e) => e.bucket)).toEqual(["dm", "scribe"]);
  });
});

describe("tape-mode replay wiring", () => {
  beforeEach(() => { __resetTapeModeForTest(); });
  afterEach(() => {
    delete process.env.MV_TAPE_MODE;
    delete process.env.MV_TAPE_PATH;
    __resetTapeModeForTest();
  });

  // Build a two-bucket tape on disk and return its path (what MV_TAPE_PATH points at).
  function writeTape(): string {
    const w = new TapeWriter("replay-unit");
    w.recordChat("dm", params("dm"), result("taped-dm"));
    w.recordChat("scribe", params("scribe"), result("taped-scribe"));
    const file = join(mkdtempSync(join(tmpdir(), "mv-replay-")), "tape.json");
    writeFileSync(file, serializeTape(w.build()));
    return file;
  }

  it("returns null when MV_TAPE_MODE is not 'replay'", () => {
    expect(replayActive()).toBe(false);
    expect(buildReplayTierProviders()).toBeNull();
  });

  it("serves every tier from one shared tape-backed provider — no connection, no key", async () => {
    process.env.MV_TAPE_MODE = "replay";
    process.env.MV_TAPE_PATH = writeTape();

    const t = buildReplayTierProviders();
    expect(t).not.toBeNull();
    // All three tiers share ONE replay provider (buckets keyed by
    // conversationId inside the provider, so sharing is correct).
    expect(t!.large.provider).toBe(t!.medium.provider);
    expect(t!.medium.provider).toBe(t!.small.provider);
    expect(t!.large.provider.providerId).toBe("replay");

    // Each bucket replays its own recorded reply, ordinally — zero network.
    expect((await t!.large.provider.chat(params("dm"))).text).toBe("taped-dm");
    expect((await t!.small.provider.chat(params("scribe"))).text).toBe("taped-scribe");
  });

  it("drives tiers with a recorded model id so capabilities resolve (not the unrecorded fallback)", () => {
    const w = new TapeWriter("replay-caps");
    w.recordCapabilities("gpt-5.5", { imageGeneration: true });
    w.recordChat("dm", params("dm"), result("taped-dm"));
    const file = join(mkdtempSync(join(tmpdir(), "mv-replay-")), "tape.json");
    writeFileSync(file, serializeTape(w.build()));
    process.env.MV_TAPE_MODE = "replay";
    process.env.MV_TAPE_PATH = file;

    const t = buildReplayTierProviders();
    // The tier model is the recorded one, so getCapabilities finds the snapshot
    // (image-gen stays enabled on replay) instead of the {imageGeneration:false}
    // fallback a synthetic, unrecorded model id would hit.
    expect(t!.large.model).toBe("gpt-5.5");
    expect(t!.large.provider.getCapabilities(t!.large.model).imageGeneration).toBe(true);
  });

  it("throws a clear error when MV_TAPE_PATH is unset", () => {
    process.env.MV_TAPE_MODE = "replay";
    expect(() => buildReplayTierProviders()).toThrow(/MV_TAPE_PATH/);
  });
});
