/**
 * Server-side error → WS-event category router.
 *
 * The three-tier taxonomy lives in the wire protocol
 * (`ErrorCategory` in `@machine-violet/shared`). This module decides
 * which bucket a thrown engine/provider error belongs in, so the bridge
 * and session-manager can broadcast it with the right discriminant and
 * the client can pick the matching UX (retry overlay / main-menu banner
 * / hard error screen).
 *
 * Routing is by error *class* and *structured field* — not by message
 * regex. Provider errors are expected to carry a structured `kind` (see
 * `CodexTurnFailedError.kind`); only one transitional regex shim survives
 * for the Anthropic refresh case, and is annotated as such.
 *
 * Conservative default: `session-fatal-recoverable`. When in doubt, drop
 * to menu and surface the verbatim message — better than claiming
 * recoverability we can't deliver, and better than a process-fatal exit
 * the player can't escape without a relaunch.
 */
import type { ErrorCategory, ServerEvent } from "@machine-violet/shared";
import { CodexTurnFailedError, type CodexFailureKind } from "../providers/openai-chatgpt/provider.js";

/**
 * Decide which WS error category a thrown error belongs in.
 *
 * Returns one of the three values from `ErrorCategory`. The default
 * fallback is `"retryable"` per the issue #529 guidance — "Conservative
 * default: when in doubt, leave as `retryable`. Better to retry once
 * than to lose session state to a transient blip." Critically, this
 * means `isSessionFatal()` only returns true for error classes we have
 * *explicitly* recognized (today: `CodexTurnFailedError`); a plain
 * `Error` from `engine.processInput` rethrows to TurnManager's retry
 * fallback the same way it did before this change.
 *
 * Callsites that have no retry path of their own (e.g. the setup error
 * broadcast — setup tears down on any failure) override the default to
 * `"session-fatal-recoverable"` so the client drops to menu with the
 * verbatim message instead of pretending the error is transient.
 */
export function classifyServerError(
  err: unknown,
  defaultCategory: ErrorCategory = "retryable",
): ErrorCategory {
  if (err instanceof CodexTurnFailedError) {
    // Every codex failure we recognize today is session-fatal: the player
    // can fix it (re-auth, change model, etc.) but the in-flight turn is
    // dead. If a future kind turns out to be transient, special-case it
    // here.
    return categoryForCodexKind(err.kind);
  }
  return defaultCategory;
}

function categoryForCodexKind(kind: CodexFailureKind): ErrorCategory {
  switch (kind) {
    case "auth_expired":
    case "model_not_found":
    case "tools_schema_mismatch":
    case "unknown":
      return "session-fatal-recoverable";
  }
}

/**
 * Drive the mid-game session-fatal teardown sequence:
 *
 *   1. `narrative:complete` — flush any half-streamed DM deltas via the
 *      *scoped* broadcast so the client's "streaming" state closes cleanly.
 *   2. `endSession("session_fatal")` — flush + checkpoint so the campaign
 *      resumes intact under "Resume" (no lost turns).
 *   3. `error` (category: session-fatal-recoverable) via the *unscoped*
 *      broadcast — sent *after* step 2 (which emits `session:ended`) so
 *      the client has already exited playing-phase before the banner data
 *      arrives.
 *
 * `scopedBroadcast` must be the per-session generation-guarded broadcast
 * so step 1 can't leak into a subsequent session if endSession races a
 * new session start. `unscopedBroadcast` is the manager's own
 * `broadcast()` — step 3 must reach the client even though the session
 * generation has changed by then.
 *
 * Extracted from SessionManager so the sequencing — which is the whole
 * point of the new bucket — has a single owner and can be unit-tested
 * without standing up a real engine + filesystem + providers.
 */
export async function performSessionFatalTeardown(opts: {
  err: unknown;
  scopedBroadcast: (event: ServerEvent) => void;
  unscopedBroadcast: (event: ServerEvent) => void;
  endSession: () => Promise<void>;
}): Promise<void> {
  const message = userMessageFor(opts.err);
  opts.scopedBroadcast({ type: "narrative:complete", data: { text: "" } });
  await opts.endSession();
  opts.unscopedBroadcast({
    type: "error",
    data: {
      message,
      recoverable: false,
      category: "session-fatal-recoverable",
    },
  });
}

/**
 * Extract the user-visible message from an error in a way that prefers
 * the upstream provider's wording.
 *
 * For `CodexTurnFailedError`, we surface the *codex* message — not our
 * wrapper string ("Codex turn <id> failed: ..."), which leaks an
 * internal turn id and adds no information for the player. For
 * everything else, fall back to `.message` (or String coercion for
 * non-Error throws).
 */
export function userMessageFor(err: unknown): string {
  if (err instanceof CodexTurnFailedError) return err.codexMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}
