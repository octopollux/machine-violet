/**
 * Tests for the server-side error → WS-event category router (#529).
 *
 * The taxonomy is enforced at the wire boundary; these tests guard the
 * specific routing decisions the bridge and session-manager rely on.
 * Wire-format propagation is covered in the client-ink event-handler
 * tests; UX wiring (menu drop + banner) is covered in app.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import type { ServerEvent } from "@machine-violet/shared";
import {
  classifyServerError,
  performSessionFatalTeardown,
  userMessageFor,
} from "./error-classify.js";
import { CodexTurnFailedError, classifyCodexFailure } from "../providers/openai-chatgpt/provider.js";

describe("classifyCodexFailure", () => {
  it("classifies the canonical refresh-token failure (#529) as auth_expired", () => {
    // Verbatim message from issue #529 — this is the trigger that
    // prompted the whole feature.
    const msg = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    expect(classifyCodexFailure(msg)).toBe("auth_expired");
  });

  it("classifies common 401 / unauthorized phrasings as auth_expired", () => {
    expect(classifyCodexFailure("HTTP 401: Unauthorized")).toBe("auth_expired");
    expect(classifyCodexFailure("Access token expired")).toBe("auth_expired");
    expect(classifyCodexFailure("access token rejected by backend")).toBe("auth_expired");
  });

  it("classifies model-not-found phrasings as model_not_found", () => {
    expect(classifyCodexFailure("model 'gpt-9' not found")).toBe("model_not_found");
    expect(classifyCodexFailure("Unknown model: foo")).toBe("model_not_found");
    expect(classifyCodexFailure("Model gpt-7 does not exist")).toBe("model_not_found");
    expect(classifyCodexFailure("No such model: bar")).toBe("model_not_found");
  });

  it("classifies tools schema failures as tools_schema_mismatch", () => {
    expect(classifyCodexFailure("invalid tool schema")).toBe("tools_schema_mismatch");
    expect(classifyCodexFailure("tool definition rejected")).toBe("tools_schema_mismatch");
  });

  it("falls back to unknown for anything else", () => {
    expect(classifyCodexFailure("some weird error")).toBe("unknown");
    expect(classifyCodexFailure("")).toBe("unknown");
  });
});

describe("CodexTurnFailedError.kind", () => {
  it("populates the kind field from the codex message at construction", () => {
    const err = new CodexTurnFailedError(
      "Your access token could not be refreshed because your refresh token was already used.",
      "t_abc",
    );
    expect(err.kind).toBe("auth_expired");
    // The verbatim codex message stays intact for user-visible display.
    expect(err.codexMessage).toContain("refresh token was already used");
  });
});

describe("classifyServerError", () => {
  it("routes every known CodexFailureKind to session-fatal-recoverable (#529)", () => {
    // All four kinds map to the same UX bucket today. Pin them so a future
    // PR that splits the routing doesn't silently misroute one.
    const err = new CodexTurnFailedError(
      "Your refresh token was already used.",
      "t1",
    );
    expect(classifyServerError(err)).toBe("session-fatal-recoverable");
  });

  it("defaults unknown error classes to retryable (Copilot review)", () => {
    // Per issue #529: "Conservative default: when in doubt, leave as
    // retryable. Better to retry once than to lose session state to a
    // transient blip." Callers that have no retry mechanism of their own
    // (e.g. the setup-error broadcast — setup tears down on any failure)
    // override with "session-fatal-recoverable".
    const plain = new Error("something boring");
    expect(classifyServerError(plain)).toBe("retryable");
    expect(classifyServerError(plain, "session-fatal-recoverable"))
      .toBe("session-fatal-recoverable");
  });

  it("survives non-Error throws (default: retryable)", () => {
    expect(classifyServerError("a string")).toBe("retryable");
    expect(classifyServerError(null)).toBe("retryable");
  });
});

describe("userMessageFor", () => {
  it("surfaces the verbatim codex message, not our wrapper string", () => {
    // CodexTurnFailedError.message bakes in the turn id, which is noise
    // for the player. The user-visible banner must show codexMessage.
    const err = new CodexTurnFailedError(
      "Your access token could not be refreshed because your refresh token was already used.",
      "01978a40-b1c2-7e3f-abcd-1234567890ab",
    );
    expect(userMessageFor(err)).toBe(
      "Your access token could not be refreshed because your refresh token was already used.",
    );
    expect(userMessageFor(err)).not.toContain("01978a40");
  });

  it("falls back to Error.message for plain errors", () => {
    expect(userMessageFor(new Error("boom"))).toBe("boom");
  });

  it("coerces non-Error throws to a string", () => {
    expect(userMessageFor("a string")).toBe("a string");
    expect(userMessageFor(42)).toBe("42");
  });
});

describe("performSessionFatalTeardown (#529 acceptance: mid-game flush)", () => {
  it("flushes streaming BEFORE endSession and broadcasts error AFTER", async () => {
    // Acceptance criterion (c): mid-game session-fatal flushes state
    // before dropping to menu so the campaign resumes cleanly.
    //
    // The sequence we're pinning:
    //   1. narrative:complete on the *scoped* broadcast (flushes any
    //      half-streamed DM deltas before endSession runs).
    //   2. endSession resolves (which would emit session:ended in
    //      production — mocked here).
    //   3. error event with category=session-fatal-recoverable on the
    //      *unscoped* broadcast (must reach the client even after the
    //      session generation flipped during endSession).
    const calls: { where: string; event?: ServerEvent }[] = [];
    const scopedBroadcast = (event: ServerEvent): void => {
      calls.push({ where: "scoped", event });
    };
    const unscopedBroadcast = (event: ServerEvent): void => {
      calls.push({ where: "unscoped", event });
    };
    const endSession = vi.fn(async () => {
      calls.push({ where: "endSession" });
    });

    const err = new CodexTurnFailedError(
      "Your refresh token was already used. Please log out and sign in again.",
      "t_xyz",
    );
    await performSessionFatalTeardown({
      err,
      scopedBroadcast,
      unscopedBroadcast,
      endSession,
    });

    // 1. The first call must be the flush via scopedBroadcast.
    expect(calls[0]).toEqual({
      where: "scoped",
      event: { type: "narrative:complete", data: { text: "" } },
    });

    // 2. endSession must run after the flush and before the error broadcast.
    expect(calls[1]).toEqual({ where: "endSession" });
    expect(endSession).toHaveBeenCalledOnce();

    // 3. The error broadcast must be last and carry the new category,
    //    routed through unscopedBroadcast so it survives generation flip.
    expect(calls[2].where).toBe("unscoped");
    expect(calls[2].event).toEqual({
      type: "error",
      data: {
        message: "Your refresh token was already used. Please log out and sign in again.",
        recoverable: false,
        category: "session-fatal-recoverable",
      },
    });
  });

  it("uses the verbatim codex message — no turn id leakage", async () => {
    // Internal turn ids are noise for the player; the banner must show
    // exactly what the provider said and nothing more.
    const events: ServerEvent[] = [];
    const err = new CodexTurnFailedError(
      "Model 'gpt-9' not found",
      "01978a40-b1c2-7e3f-deadbeef",
    );
    await performSessionFatalTeardown({
      err,
      scopedBroadcast: () => { /* irrelevant for this assertion */ },
      unscopedBroadcast: (e) => events.push(e),
      endSession: async () => { /* no-op */ },
    });
    const errorEvent = events.find((e) => e.type === "error");
    const message = (errorEvent?.data as { message: string }).message;
    expect(message).toBe("Model 'gpt-9' not found");
    expect(message).not.toContain("01978a40");
  });
});

describe("retry-path category back-compat (#529 acceptance: 429 still retries)", () => {
  it("default category is preserved as retryable when the caller asks", () => {
    // Acceptance criterion (d): a 429 still routes to the retry overlay.
    // The retry path uses classifyServerError(err, "retryable") so plain
    // errors without a structured `kind` stay in the retry bucket — they
    // don't get demoted to session-fatal by the default.
    const plain = new Error("API retry (status 429)");
    expect(classifyServerError(plain, "retryable")).toBe("retryable");
  });
});

