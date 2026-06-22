/**
 * Record/replay decorators around {@link LLMProvider} — the Tier-2 seam.
 *
 * - {@link createTapingProvider} wraps a real provider and tapes every
 *   `chat`/`stream`/`generateImage` result while forwarding to the inner
 *   provider unchanged. Used during a live record pilot.
 * - {@link createReplayProvider} satisfies the whole `LLMProvider` interface
 *   from a {@link TapeReader} with NO inner provider and NO network — the
 *   deterministic backbone. A request with no matching taped entry throws
 *   loudly ("tape is stale, re-record") rather than falling back to the wire.
 *
 * Both are wired in at `buildTierProvidersWithCache` (the single chokepoint
 * every engine LLM call resolves its provider through), gated by an env flag,
 * so production never sees either.
 */
import type {
  ChatParams,
  ChatResult,
  GenerateImageRequest,
  GenerateImageResult,
  HealthCheckResult,
  LLMProvider,
  ProviderCapabilities,
} from "./types.js";
import { bucketOf, type TapeReader, type TapeWriter } from "./tape.js";

/** Wrap a real provider so every interaction is appended to `writer`. */
export function createTapingProvider(inner: LLMProvider, writer: TapeWriter): LLMProvider {
  const taping: LLMProvider = {
    providerId: `taping:${inner.providerId}`,

    getCapabilities(model: string): ProviderCapabilities {
      const caps = inner.getCapabilities(model);
      writer.recordCapabilities(model, caps);
      return caps;
    },

    async chat(params: ChatParams): Promise<ChatResult> {
      // Capture caps opportunistically (cheap + pure) so any chatted model is
      // self-sufficient in the tape, even if nothing called getCapabilities.
      writer.recordCapabilities(params.model, inner.getCapabilities(params.model));
      const result = await inner.chat(params);
      writer.recordChat(bucketOf(params), params, result);
      return result;
    },

    async stream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult> {
      writer.recordCapabilities(params.model, inner.getCapabilities(params.model));
      const deltas: string[] = [];
      const result = await inner.stream(params, (d) => {
        deltas.push(d);
        onDelta(d);
      });
      writer.recordChat(bucketOf(params), params, result, deltas);
      return result;
    },

    healthCheck: (model?: string) => inner.healthCheck(model),
  };

  // Forward optional members only when the inner provider supports them, so
  // capability probes (e.g. `provider.generateImage != null`) stay accurate.
  // Bind the narrowed reference rather than using `!` (forbidden by lint).
  if (inner.generateImage) {
    const generateImage = inner.generateImage.bind(inner);
    taping.generateImage = async (req: GenerateImageRequest): Promise<GenerateImageResult> => {
      const result = await generateImage(req);
      writer.recordImage(req, result);
      return result;
    };
  }
  if (inner.getUsageStatus) taping.getUsageStatus = inner.getUsageStatus.bind(inner);
  if (inner.subscribeUsage) taping.subscribeUsage = inner.subscribeUsage.bind(inner);
  if (inner.dispose) taping.dispose = inner.dispose.bind(inner);

  return taping;
}

/** Build a provider that serves entirely from a recorded tape (no network). */
export function createReplayProvider(reader: TapeReader): LLMProvider {
  const cursors = new Map<string, number>();
  let imageCursor = 0;

  function takeChat(params: ChatParams) {
    const bucket = bucketOf(params);
    const ordinal = cursors.get(bucket) ?? 0;
    cursors.set(bucket, ordinal + 1);
    const entry = reader.chatAt(bucket, ordinal);
    if (!entry) {
      throw new Error(
        `Tape miss: no chat entry for bucket="${bucket}" ordinal=${ordinal}. ` +
          `The tape is stale (request: model=${params.model}, messages=${params.messages.length}). Re-record the golden.`,
      );
    }
    return entry;
  }

  return {
    providerId: "replay",

    getCapabilities(model: string): ProviderCapabilities {
      // Unrecorded model → assume no image-gen so the engine omits that tooling.
      return reader.capabilities(model) ?? { imageGeneration: false };
    },

    async chat(params: ChatParams): Promise<ChatResult> {
      const result = takeChat(params).result;
      if (isInternalDispatchRecording(params, result)) await replayToolDispatch(params, result);
      return result;
    },

    async stream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult> {
      const entry = takeChat(params);
      // Re-emit the recorded deltas — the verbatim streamed text the player saw
      // (assistantContent text blocks differ from the stream for codex and can
      // duplicate). Fall back to one delta of the full text for chat()-taped
      // entries.
      for (const d of entry.streamDeltas ?? [entry.result.text]) onDelta(d);
      // Then re-issue the in-band tool dispatches so the engine sees
      // present_choices / finalize_setup / scribe / style_scene etc. Exact
      // segmentation around tool boundaries isn't reproduced (the assertion
      // normalizes whitespace), but every side effect and the full narrative
      // content is.
      if (isInternalDispatchRecording(params, entry.result)) await replayToolDispatch(params, entry.result);
      return entry.result;
    },

    async healthCheck(): Promise<HealthCheckResult> {
      return { status: "valid", message: "replay provider (no network)" };
    },

    async generateImage(_req: GenerateImageRequest): Promise<GenerateImageResult> {
      const entry = reader.imageAt(imageCursor++);
      if (!entry) {
        throw new Error(
          `Tape miss: no image entry at ordinal ${imageCursor - 1}. The tape is stale. Re-record the golden.`,
        );
      }
      return entry.result;
    },
  };
}

/**
 * True when the recorded result came from an internal-dispatch provider
 * (openai-chatgpt / codex app-server): the model's tool calls were dispatched
 * in-band via `params.dispatchTool` during the turn, so they survive only as
 * `tool_use` blocks in `assistantContent` and `ChatResult.toolCalls` is empty.
 * Anthropic-shape recordings surface tool calls via `toolCalls` (dispatched by
 * the outer agent loop) — replaying those through `dispatchTool` would
 * double-dispatch, so we exclude them here.
 */
function isInternalDispatchRecording(params: ChatParams, result: ChatResult): boolean {
  return (
    params.dispatchTool != null &&
    result.toolCalls.length === 0 &&
    result.assistantContent.some((b) => b.type === "tool_use")
  );
}

/**
 * Re-issue a codex-shape turn's tool calls (the `tool_use` blocks in
 * `assistantContent`) through `params.dispatchTool`, in recorded order, so the
 * engine sees every side effect: present_choices / finalize_setup / set_portrait
 * / scribe / style_scene … Dispatch results are discarded — the model's
 * continuation is fixed by the tape; only the side effects matter on replay.
 */
async function replayToolDispatch(params: ChatParams, result: ChatResult): Promise<void> {
  if (!params.dispatchTool) return;
  for (const part of result.assistantContent) {
    if (part.type === "tool_use") {
      await params.dispatchTool({ id: part.id, name: part.name, input: part.input });
    }
  }
}
