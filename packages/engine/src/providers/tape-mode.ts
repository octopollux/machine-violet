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
 * Replay does NOT go through here: the deterministic Tier-2 runner constructs
 * the engine in-process with a replay provider directly.
 *
 * Production never sets `MV_TAPE_MODE`, so `wrapForRecording` is an identity
 * pass-through and these providers behave exactly as built.
 */
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import type { LLMProvider, TierProvider } from "./types.js";
import { TapeWriter, type Tape } from "./tape.js";
import { createTapingProvider } from "./tape-provider.js";

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

/** Test-only: clear the process-global recorder state between cases. */
export function __resetTapeModeForTest(): void {
  writer = null;
  wrapped = new WeakMap<LLMProvider, LLMProvider>();
}
