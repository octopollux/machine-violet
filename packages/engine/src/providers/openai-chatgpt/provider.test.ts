import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurnCollector, CodexTurnFailedError, messageToResponsesItems,
  buildImagePromptText, extractGeneratedImage, createOpenAIChatGptProvider,
  shouldRetryImageRender, ImageGenNoDataError,
  summarizeItem, readNewestPngAsBase64, removeGeneratedImageDir,
  buildThreadStartParams,
} from "./provider.js";
import type {
  AgentMessageDeltaNotification, ItemCompletedNotification,
  TurnCompletedNotification, RawResponseItemCompletedNotification,
  ItemBase,
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
// Reasoning drop-detector (issues #533 / #597 / #607)
// ---------------------------------------------------------------------------
//
// We capture no encrypted reasoning blob on the codex path — codex emits none
// on the ChatGPT-account path, so #533 replay was removed as a no-op (#607).
// `onRawResponseItem` survives only to COUNT reasoning items for the #597
// tripwire; nothing reaches assistantContent.

function rawReasoning(overrides: Partial<RawResponseItemCompletedNotification["item"]> & { id: string }): RawResponseItemCompletedNotification {
  return {
    threadId: "t1",
    turnId: "turn_1",
    item: { type: "reasoning", ...overrides },
  };
}

describe("TurnCollector: reasoning drop-detector", () => {
  it("never puts a reasoning block in assistantContent, even when a blob is present", () => {
    // Defends the removal: even if codex DID hand us an encrypted blob, we no
    // longer round-trip it — there is no replay path left to feed.
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
    expect(result.assistantContent).toEqual([{ type: "text", text: "Onward." }]);
    expect(result.assistantContent.some((p) => p.type === "reasoning")).toBe(false);
  });

  it("ignores non-reasoning raw items", () => {
    // Codex emits rawResponseItem/completed for every Responses-API item type
    // (message, function_call, …). Only reasoning items are counted; the rest
    // flow through item/completed and never touch the detector.
    const c = new TurnCollector();
    c.onRawResponseItem({
      threadId: "t1",
      turnId: "turn_1",
      item: { type: "message", id: "msg_x", content: "ignored" },
    });
    c.onItemCompleted(agentMessageCompleted("Hello."));
    const result = c.toChatResult(completedTurn());

    expect(result.assistantContent).toEqual([{ type: "text", text: "Hello." }]);
    expect(c.reasoningCaptureStats().rawReasoningItems).toBe(0);
  });

  it("reasoningCaptureStats counts summary deltas and raw reasoning items", () => {
    // The #597 tripwire reads these. Every reasoning raw item counts toward
    // rawReasoningItems regardless of blob content (a ChatGPT account never
    // carries one); summaryDeltas proves the model reasoned.
    const c = new TurnCollector();
    c.onReasoningDelta(agentMessageDelta("Thinking"));
    c.onReasoningDelta(agentMessageDelta(" harder."));
    c.onRawResponseItem(rawReasoning({ id: "rs_1", encrypted_content: "blob", summary: [] }));
    c.onRawResponseItem(rawReasoning({ id: "rs_2", encrypted_content: null, summary: [] }));

    expect(c.reasoningCaptureStats()).toEqual({
      summaryDeltas: 2,
      rawReasoningItems: 2,
    });
  });

  it("flags the steady state: model reasoned but no raw reasoning item arrived", () => {
    // Reasoning-summary deltas streamed (so the model reasoned) yet
    // rawResponseItem/completed never landed — the once-per-session condition
    // runTurn logs as codex:rpc:reasoning_item_missing (#597). On a ChatGPT
    // account this is the expected steady state (#607), not a transport drop.
    const c = new TurnCollector();
    c.onReasoningDelta(agentMessageDelta("Weighed it."));
    const stats = c.reasoningCaptureStats();

    expect(stats.summaryDeltas).toBeGreaterThan(0);
    expect(stats.rawReasoningItems).toBe(0);
  });
});

describe("messageToResponsesItems: non-text blocks dropped on codex (issues #533/#607)", () => {
  it("drops reasoning and Anthropic thinking blocks (codex rejects them on input)", () => {
    // codex neither produces nor accepts reasoning blobs on the ChatGPT path
    // (#607), and Anthropic thinking/redacted_thinking are foreign shapes. A
    // `reasoning` part can only reach here via a mid-campaign connection switch
    // from the openai-apikey path; we drop all three, keeping only the text.
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", id: "rs_1", encryptedContent: "enc-1", summary: ["Pondered."] },
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

  it("still encodes assistant text + tool_use in source order", () => {
    const msg: NormalizedMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Onward." },
        { type: "tool_use", id: "call_1", name: "roll_dice", input: { sides: 20 } },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Onward." }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "roll_dice",
        arguments: JSON.stringify({ sides: 20 }),
      },
    ]);
  });
});

describe("messageToResponsesItems: image_input (party portraits)", () => {
  it("folds text + image_input into one user message with input_image parts", () => {
    // The portrait prefix: a label line followed by one image_input per PC.
    // Both must ride in a single message so each image stays with its label.
    const msg: NormalizedMessage = {
      role: "user",
      content: [
        { type: "text", text: "Party portraits:" },
        { type: "image_input", base64: "AAAA", mimeType: "image/png", lowDetail: true, label: "Wendy" },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Party portraits:" },
          // detail maps to codex's enum (high|original), NOT the OpenAI
          // SDK's low/auto — codex rejects those. lowDetail:true → "high".
          { type: "input_image", detail: "high", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("maps lowDetail:false to detail \"original\"", () => {
    const msg: NormalizedMessage = {
      role: "user",
      content: [
        { type: "image_input", base64: "BBBB", mimeType: "image/jpeg", lowDetail: false, label: "x" },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", detail: "original", image_url: "data:image/jpeg;base64,BBBB" },
        ],
      },
    ]);
  });

  it("keeps tool_result blocks as standalone function_call_output items", () => {
    const msg: NormalizedMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_9", content: "ok" }],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      { type: "function_call_output", call_id: "call_9", output: "ok" },
    ]);
  });

  it("preserves source order when text/image interleave with tool_result", () => {
    // Edge case (imported / hand-edited history): a single user message mixing
    // text and a tool_result. Text before the result must stay before its
    // function_call_output, and text after it must come after.
    const msg: NormalizedMessage = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
        { type: "text", text: "after" },
      ],
    };
    const items = messageToResponsesItems(msg);
    expect(items).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Image generation (Phase 7 — codex built-in image_gen skill)
// ---------------------------------------------------------------------------

describe("getCapabilities", () => {
  it("reports imageGeneration: true regardless of model", () => {
    // Image gen routes through codex's built-in image_gen skill (no API key,
    // billed to the ChatGPT plan), which ships with codex across the gpt-5.x
    // family. Construction is sync + cheap — no subprocess spawned.
    const provider = createOpenAIChatGptProvider();
    expect(provider.getCapabilities!("gpt-5.5").imageGeneration).toBe(true);
    expect(provider.getCapabilities!("gpt-5.4-mini").imageGeneration).toBe(true);
  });

  it("exposes generateImage as a defined method", () => {
    const provider = createOpenAIChatGptProvider();
    expect(typeof provider.generateImage).toBe("function");
  });
});

describe("buildThreadStartParams", () => {
  const base = { model: "gpt-5.5", developerInstructions: "be a DM", cwd: "/cwd" };

  it("strips codex's base prompt by default — baseInstructions is \"\"", () => {
    const p = buildThreadStartParams(base);
    // The whole point of the change: an absent baseInstructions REPLACES codex's
    // coding-agent base with an empty string, not "leave codex's default".
    expect(p.baseInstructions).toBe("");
    // And it must actually be present in the payload (not undefined/omitted),
    // or codex would fall back to its own base prompt.
    expect("baseInstructions" in p).toBe(true);
  });

  it("respects an explicit baseInstructions override", () => {
    const p = buildThreadStartParams({ ...base, baseInstructions: "you run TTRPGs" });
    expect(p.baseInstructions).toBe("you run TTRPGs");
  });

  it("passes through developer instructions + the fixed read-only/no-approval config", () => {
    const p = buildThreadStartParams(base);
    expect(p.developerInstructions).toBe("be a DM");
    expect(p.model).toBe("gpt-5.5");
    expect(p.cwd).toBe("/cwd");
    expect(p.sandbox).toBe("read-only");
    expect(p.approvalPolicy).toBe("never");
  });

  it("includes dynamicTools only when provided", () => {
    expect("dynamicTools" in buildThreadStartParams(base)).toBe(false);
    const tools = [{ name: "roll_dice", description: "", inputSchema: {} }];
    expect(buildThreadStartParams({ ...base, dynamicTools: tools }).dynamicTools).toBe(tools);
  });
});

describe("buildImagePromptText", () => {
  it("prepends landscape guidance for landscape aspect", () => {
    const text = buildImagePromptText("a red cube", "landscape");
    expect(text).toContain("landscape orientation");
    expect(text).toContain("1536x1024");
    expect(text).toContain("a red cube");
  });

  it("prepends portrait guidance for portrait aspect", () => {
    const text = buildImagePromptText("a hero", "portrait");
    expect(text).toContain("vertical portrait");
    expect(text).toContain("1024x1536");
  });

  it("prepends square guidance for square aspect", () => {
    const text = buildImagePromptText("a sigil", "square");
    expect(text).toContain("square 1:1");
    expect(text).toContain("1024x1024");
  });

  it("folds in NO effort/quality steering — effort is a no-op on the codex path", () => {
    // The built-in image_gen tool has no quality/size param and the backend
    // renders at a fixed budget regardless of wording (live-verified), so the
    // render prompt must carry only aspect + subject, never fidelity/speed
    // directives. Guards against re-introducing the misleading steering.
    const text = buildImagePromptText("a quiet harbor", "square");
    expect(text).not.toMatch(/fidelity|quality|render quickly|hero-shot|slowest/i);
    expect(text).toBe("Use a square 1:1 orientation (roughly 1024x1024). a quiet harbor");
  });

  it("appends a reference directive naming the characters only when labels are given", () => {
    const none = buildImagePromptText("a scene", "landscape");
    expect(none).not.toMatch(/reference image/i);

    const one = buildImagePromptText("a scene", "portrait", ["Xera"]);
    expect(one).toMatch(/reference image is the established appearance of Xera/i);
    expect(one).toMatch(/match that character's facial features, build, and outfit/i);

    const two = buildImagePromptText("a scene", "landscape", ["Xera", "Vera"]);
    expect(two).toMatch(/reference images are the established appearance of Xera and Vera/i);
    expect(two).toMatch(/match their facial features, build, and outfit/i);
  });
});

describe("shouldRetryImageRender", () => {
  const MAX = 3;
  it("retries a transient no-data failure while attempts remain", () => {
    expect(shouldRetryImageRender(new ImageGenNoDataError("no bytes"), 1, MAX)).toBe(true);
    expect(shouldRetryImageRender(new ImageGenNoDataError("no bytes"), 2, MAX)).toBe(true);
  });

  it("does not retry the no-data failure on the final attempt", () => {
    expect(shouldRetryImageRender(new ImageGenNoDataError("no bytes"), MAX, MAX)).toBe(false);
  });

  it("never retries a non-transient failure (failed turn, timeout, auth)", () => {
    expect(shouldRetryImageRender(new CodexTurnFailedError("refused", "t1"), 1, MAX)).toBe(false);
    expect(shouldRetryImageRender(new Error("image render turn timed out after 600s"), 1, MAX)).toBe(false);
    expect(shouldRetryImageRender("not even an error", 1, MAX)).toBe(false);
  });
});

describe("extractGeneratedImage", () => {
  const imageItem = (overrides: Partial<ItemBase>): ItemBase =>
    ({ id: "ig_1", type: "imageGeneration", ...overrides }) as ItemBase;

  it("extracts base64 bytes + revisedPrompt from a populated imageGeneration item", () => {
    const got = extractGeneratedImage(imageItem({
      status: "generating",
      result: "iVBORw0KGgoABASE64",
      revisedPrompt: "A wide landscape painting of a red cube.",
    }));
    expect(got).toEqual({
      base64: "iVBORw0KGgoABASE64",
      revisedPrompt: "A wide landscape painting of a red cube.",
    });
  });

  it("omits revisedPrompt when codex returned null", () => {
    const got = extractGeneratedImage(imageItem({ result: "iVBORw0KGgo", revisedPrompt: null }));
    expect(got).toEqual({ base64: "iVBORw0KGgo" });
    expect(got).not.toHaveProperty("revisedPrompt");
  });

  it("returns null for the in_progress placeholder (empty result)", () => {
    // item/started fires first with result: "" — must not be harvested.
    expect(extractGeneratedImage(imageItem({ status: "in_progress", result: "" }))).toBeNull();
  });

  it("returns null for non-imageGeneration items", () => {
    expect(extractGeneratedImage({ id: "msg_1", type: "agentMessage", text: "hi" } as ItemBase)).toBeNull();
    expect(extractGeneratedImage({ id: "c_1", type: "commandExecution" } as ItemBase)).toBeNull();
  });
});

describe("summarizeItem", () => {
  it("records result byte-length (not bytes) for imageGeneration items", () => {
    // A byteless render must surface resultLen: 0 rather than vanish, and we
    // must never copy the multi-MB base64 into the log.
    expect(summarizeItem({ id: "ig_1", type: "imageGeneration", status: "generating", result: "" } as ItemBase))
      .toEqual({ type: "imageGeneration", status: "generating", resultLen: 0 });
    expect(summarizeItem({ id: "ig_2", type: "imageGeneration", result: "AAAA" } as ItemBase))
      .toEqual({ type: "imageGeneration", resultLen: 4 });
  });

  it("captures a short text preview so a model refusal surfaces", () => {
    const long = "I can't create that image because ".repeat(20);
    const s = summarizeItem({ id: "m1", type: "agentMessage", text: long } as ItemBase);
    expect(s.type).toBe("agentMessage");
    expect(s.textPreview).toHaveLength(200);
    expect(s.textPreview!.startsWith("I can't create that image")).toBe(true);
    expect(s).not.toHaveProperty("resultLen");
  });

  it("records tool + success for tool-call items", () => {
    expect(summarizeItem({ id: "t1", type: "toolCall", tool: "image_gen", success: false } as ItemBase))
      .toEqual({ type: "toolCall", tool: "image_gen", success: false });
  });
});

describe("readNewestPngAsBase64 (disk image harvest)", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "mv-imggen-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("reads a PNG written to a session dir and returns it base64-encoded", async () => {
    await withTempDir(async (root) => {
      const sessionDir = join(root, "generated_images", "019ea7c8-sess");
      await mkdir(sessionDir, { recursive: true });
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
      await writeFile(join(sessionDir, "ig_abc.png"), bytes);

      const got = await readNewestPngAsBase64(sessionDir);
      expect(got).toEqual({ base64: bytes.toString("base64") });
    });
  });

  it("returns null when the session dir does not exist (no image written)", async () => {
    await withTempDir(async (root) => {
      expect(await readNewestPngAsBase64(join(root, "nope"))).toBeNull();
    });
  });

  it("returns null for an empty dir or a dir with no PNGs", async () => {
    await withTempDir(async (root) => {
      const empty = join(root, "empty");
      await mkdir(empty, { recursive: true });
      expect(await readNewestPngAsBase64(empty)).toBeNull();

      await writeFile(join(empty, "notes.txt"), "not an image");
      expect(await readNewestPngAsBase64(empty)).toBeNull();
    });
  });

  it("returns null for a zero-byte PNG (treated as no image)", async () => {
    await withTempDir(async (root) => {
      const d = join(root, "s");
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "ig_empty.png"), Buffer.alloc(0));
      expect(await readNewestPngAsBase64(d)).toBeNull();
    });
  });

  it("picks the newest PNG when several exist", async () => {
    await withTempDir(async (root) => {
      const d = join(root, "s");
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "ig_old.png"), Buffer.from([1, 1, 1]));
      // Force a later mtime on the second file.
      await new Promise((r) => setTimeout(r, 12));
      const newer = Buffer.from([2, 2, 2, 2]);
      await writeFile(join(d, "ig_new.png"), newer);

      const got = await readNewestPngAsBase64(d);
      expect(got).toEqual({ base64: newer.toString("base64") });
    });
  });
});

describe("removeGeneratedImageDir (post-harvest cleanup)", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "mv-imggen-rm-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("removes the per-session dir and the redundant PNG it holds", async () => {
    await withTempDir(async (root) => {
      const sessionDir = join(root, "generated_images", "019ea7c8-sess");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "ig_abc.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      await removeGeneratedImageDir(sessionDir);

      // Dir is gone; the sibling generated_images parent is untouched.
      await expect(readdir(sessionDir)).rejects.toThrow();
      expect(await readdir(join(root, "generated_images"))).toEqual([]);
    });
  });

  it("is a no-op (never throws) when the dir does not exist", async () => {
    await withTempDir(async (root) => {
      await expect(removeGeneratedImageDir(join(root, "nope"))).resolves.toBeUndefined();
    });
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
