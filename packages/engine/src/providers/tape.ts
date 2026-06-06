/**
 * Session-tape format for deterministic record/replay testing (Tier 2).
 *
 * A tape captures every LLM interaction a session made — `chat`/`stream`
 * results and `generateImage` results — keyed so a later run can replay them
 * with no network. Text turns are bucketed by `conversationId` (the agent
 * name: "dm", "scribe", setup, …) and matched **ordinally** within a bucket:
 * the Nth call in bucket B during replay returns the Nth recorded entry for B.
 *
 * Matching is deliberately loose. We do NOT hash the full request and demand
 * an exact match — prompts churn constantly, and a benign wording tweak should
 * yield a readable diff + one re-record, not a cache-miss storm. The stored
 * {@link RequestFingerprint} is for human diff-legibility and soft validation,
 * not for keying.
 *
 * Lives in `engine` (not `test-harness`) because it serializes engine-owned
 * types (`ChatResult` et al.); the replay runner in `test-harness` imports it,
 * keeping the dependency direction test-harness → engine.
 */
import { createHash } from "node:crypto";
import type {
  ChatParams,
  ChatResult,
  GenerateImageRequest,
  GenerateImageResult,
  ProviderCapabilities,
  SystemBlock,
} from "./types.js";

export const TAPE_VERSION = 1 as const;

/** Bucket used for `generateImage` calls (they carry no `conversationId`). */
export const IMAGE_BUCKET = "__image__";

/**
 * Compact, readable fingerprint of a request. Stored for diff-legibility and
 * soft validation — NEVER used as the match key (that's bucket + ordinal).
 */
export interface RequestFingerprint {
  model: string;
  /** Message count on this call (grows each turn). */
  messageCount: number;
  /** Short sha256 prefix of the system prompt text — catches system drift. */
  systemHash: string;
  /** Tool names offered on this call, sorted. */
  tools: string[];
  /** Truncated preview of the last message's text, for human scanning. */
  lastMessagePreview: string;
}

export interface TapeChatEntry {
  kind: "chat";
  bucket: string;
  ordinal: number;
  request: RequestFingerprint;
  result: ChatResult;
  /** Deltas as recorded from `stream`; absent for non-streaming `chat` calls. */
  streamDeltas?: string[];
}

export interface TapeImageEntry {
  kind: "image";
  bucket: typeof IMAGE_BUCKET;
  ordinal: number;
  request: GenerateImageRequest;
  // TODO(corpus slice): move base64 out-of-line (content-addressed sidecar)
  // so image-bearing goldens stay diffable. Inline is fine for text-only tapes.
  result: GenerateImageResult;
}

export type TapeEntry = TapeChatEntry | TapeImageEntry;

export interface Tape {
  version: typeof TAPE_VERSION;
  scenario: string;
  /** Per-model capability snapshot captured at record time, replayed verbatim. */
  capabilities: Record<string, ProviderCapabilities>;
  entries: TapeEntry[];
}

/** The replay bucket for a request: its agent chain id, or "default". */
export function bucketOf(params: Pick<ChatParams, "conversationId">): string {
  return params.conversationId ?? "default";
}

function systemText(system: string | SystemBlock[]): string {
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n");
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function lastMessagePreview(params: ChatParams): string {
  const last = params.messages.at(-1);
  if (!last) return "";
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function fingerprint(params: ChatParams): RequestFingerprint {
  return {
    model: params.model,
    messageCount: params.messages.length,
    systemHash: shortHash(systemText(params.systemPrompt)),
    tools: (params.tools ?? []).map((t) => t.name).sort(),
    lastMessagePreview: lastMessagePreview(params),
  };
}

/**
 * Accumulates a tape during a record run. One writer spans the whole session
 * (and, for a setup→game scenario, both sessions) so buckets stay continuous.
 */
export class TapeWriter {
  private readonly entries: TapeEntry[] = [];
  private readonly caps: Record<string, ProviderCapabilities> = {};
  private readonly cursors = new Map<string, number>();

  constructor(readonly scenario: string) {}

  private nextOrdinal(bucket: string): number {
    const ordinal = this.cursors.get(bucket) ?? 0;
    this.cursors.set(bucket, ordinal + 1);
    return ordinal;
  }

  recordCapabilities(model: string, caps: ProviderCapabilities): void {
    this.caps[model] = caps;
  }

  recordChat(bucket: string, params: ChatParams, result: ChatResult, streamDeltas?: string[]): void {
    this.entries.push({
      kind: "chat",
      bucket,
      ordinal: this.nextOrdinal(bucket),
      request: fingerprint(params),
      result,
      ...(streamDeltas ? { streamDeltas } : {}),
    });
  }

  recordImage(request: GenerateImageRequest, result: GenerateImageResult): void {
    this.entries.push({
      kind: "image",
      bucket: IMAGE_BUCKET,
      ordinal: this.nextOrdinal(IMAGE_BUCKET),
      request,
      result,
    });
  }

  build(): Tape {
    // Snapshot: copy the array + object so a stored tape doesn't mutate if
    // recording continues (e.g. getRecordedTape() read mid-session).
    return { version: TAPE_VERSION, scenario: this.scenario, capabilities: { ...this.caps }, entries: [...this.entries] };
  }
}

/** Indexed read access over a tape for the replay provider. */
export class TapeReader {
  private readonly chatsByBucket = new Map<string, TapeChatEntry[]>();
  private readonly imageEntries: TapeImageEntry[] = [];

  constructor(private readonly tape: Tape) {
    for (const e of tape.entries) {
      if (e.kind === "chat") {
        const arr = this.chatsByBucket.get(e.bucket) ?? [];
        arr.push(e);
        this.chatsByBucket.set(e.bucket, arr);
      } else {
        this.imageEntries.push(e);
      }
    }
    for (const arr of this.chatsByBucket.values()) arr.sort((a, b) => a.ordinal - b.ordinal);
    this.imageEntries.sort((a, b) => a.ordinal - b.ordinal);
  }

  get scenario(): string {
    return this.tape.scenario;
  }

  capabilities(model: string): ProviderCapabilities | undefined {
    return this.tape.capabilities[model];
  }

  chatAt(bucket: string, ordinal: number): TapeChatEntry | undefined {
    return this.chatsByBucket.get(bucket)?.[ordinal];
  }

  imageAt(ordinal: number): TapeImageEntry | undefined {
    return this.imageEntries[ordinal];
  }
}

export function serializeTape(tape: Tape): string {
  return JSON.stringify(tape, null, 2) + "\n";
}

export function deserializeTape(json: string): Tape {
  const parsed = JSON.parse(json) as Tape;
  if (parsed.version !== TAPE_VERSION) {
    throw new Error(`Unsupported tape version ${parsed.version} (expected ${TAPE_VERSION}); re-record the golden.`);
  }
  return parsed;
}
