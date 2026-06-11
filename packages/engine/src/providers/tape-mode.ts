/**
 * Record-mode wiring for session tapes.
 *
 * When `MV_TAPE_MODE=record`, {@link wrapForRecording} decorates the per-tier
 * providers so every LLM interaction across setup + gameplay is taped into one
 * process-global {@link TapeWriter}. The recorded tape is read back out-of-band
 * by the test-harness recorder (via a dev-only engine route) AFTER the live
 * pilot finishes — we deliberately do NOT flush on process exit, because the
 * harness force-kills the process tree (`taskkill /F`), which skips exit
 * handlers (see packages/test-harness/src/harness.ts).
 *
 * Replay has two homes: the in-process Tier-2 runner constructs the engine
 * directly with a replay provider (it never touches this module), while
 * full-stack / packaged-binary replay flows through {@link buildReplayTierProviders}
 * here — `MV_TAPE_MODE=replay` serves every tier from a tape, so the real
 * server stack (and, in CI, the packaged binary) runs with no connection,
 * network, or API key.
 *
 * Production never sets `MV_TAPE_MODE`, so `wrapForRecording` is an identity
 * pass-through, `buildReplayTierProviders` returns null, and these providers
 * behave exactly as built.
 */
import { readFileSync } from "node:fs";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import type { LLMProvider, TierProvider } from "./types.js";
import { TapeReader, TapeWriter, deserializeTape, type Tape } from "./tape.js";
import { createReplayProvider, createTapingProvider } from "./tape-provider.js";

export function recordingActive(): boolean {
  return process.env.MV_TAPE_MODE === "record";
}

let writer: TapeWriter | null = null;
function getWriter(): TapeWriter {
  if (!writer) writer = new TapeWriter(process.env.MV_TAPE_SCENARIO ?? "session");
  return writer;
}

// Dedupe by inner-provider identity: tiers commonly share one provider
// instance (e.g. medium + small on the same connection), and wrapping each
// TierProvider separately would tape the same calls twice.
let wrapped = new WeakMap<LLMProvider, LLMProvider>();

/**
 * If recording is active, return a tier map whose providers tape every call
 * into the shared writer; otherwise return `tiers` unchanged. Safe (and
 * intended) to call unconditionally at every provider-resolution site.
 */
export function wrapForRecording(tiers: Record<ModelTier, TierProvider>): Record<ModelTier, TierProvider> {
  if (!recordingActive()) return tiers;
  const w = getWriter();
  const wrap = (tp: TierProvider): TierProvider => {
    let taping = wrapped.get(tp.provider);
    if (!taping) {
      taping = createTapingProvider(tp.provider, w);
      wrapped.set(tp.provider, taping);
    }
    return { provider: taping, model: tp.model };
  };
  return { large: wrap(tiers.large), medium: wrap(tiers.medium), small: wrap(tiers.small) };
}

/** The tape recorded so far this process, or null if not recording. */
export function getRecordedTape(): Tape | null {
  return recordingActive() && writer ? writer.build() : null;
}

// ---------------------------------------------------------------------------
// Replay mode (full-stack / packaged-binary E2E).
//
// `MV_TAPE_MODE=replay` + `MV_TAPE_PATH=<serialized tape>` makes the provider
// seam serve every tier from a recorded tape — no connection, no network, no
// API key. This is what lets the deterministic golden replay run against the
// *running server stack* (and, in CI, the packaged binary), not just the
// in-process Tier-2 runner. The harness writes the bare serialized Tape to
// MV_TAPE_PATH (extracted from the golden envelope) before launching.
//
// Gated, env-only, never set in production. See docs/e2e-harness.md.
// ---------------------------------------------------------------------------

/** Synthetic model id for replayed tiers; the replay provider ignores it. */
const REPLAY_MODEL = "replay-tape";

export function replayActive(): boolean {
  return process.env.MV_TAPE_MODE === "replay";
}

let reader: TapeReader | null = null;
function getReader(): TapeReader {
  if (reader) return reader;
  const path = process.env.MV_TAPE_PATH;
  if (!path) throw new Error("MV_TAPE_MODE=replay requires MV_TAPE_PATH to point at a serialized tape");
  reader = new TapeReader(deserializeTape(readFileSync(path, "utf8")));
  return reader;
}

/**
 * In replay mode, a tier map whose three tiers share ONE tape-backed provider
 * (buckets are keyed by conversationId inside the provider, so a single shared
 * instance is correct — this mirrors the in-process corpus runner, which hands
 * the same replay provider to all three tiers). Returns null when replay is
 * inactive, so callers fall through to live connection resolution.
 */
export function buildReplayTierProviders(): Record<ModelTier, TierProvider> | null {
  if (!replayActive()) return null;
  const provider = createReplayProvider(getReader());
  const tp = (): TierProvider => ({ provider, model: REPLAY_MODEL });
  return { large: tp(), medium: tp(), small: tp() };
}

/** Test-only: clear the process-global recorder/replay state between cases. */
export function __resetTapeModeForTest(): void {
  writer = null;
  reader = null;
  wrapped = new WeakMap<LLMProvider, LLMProvider>();
}
