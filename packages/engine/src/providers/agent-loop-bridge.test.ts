import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage, ContentPart } from "./types.js";
import { runProviderLoop } from "./agent-loop-bridge.js";

function mockUsage(): NormalizedUsage {
  return { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResult(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

/** A round that emits text alongside a tool_use, prompting another loop iteration. */
function textPlusToolResult(text: string, toolName: string, toolId = "toolu_1"): ChatResult {
  const assistantContent: ChatResult["assistantContent"] = [];
  if (text) assistantContent.push({ type: "text", text });
  assistantContent.push({ type: "tool_use", id: toolId, name: toolName, input: {} });
  return {
    text,
    toolCalls: [{ id: toolId, name: toolName, input: {} }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent,
  };
}

function apiError(status: number, message = "error"): Error {
  const err = new Error(message);
  (err as unknown as Record<string, unknown>).status = status;
  return err;
}

function networkError(): Error {
  const err = new Error("fetch failed");
  err.name = "TypeError";
  return err;
}

describe("runProviderLoop retry", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries on 429 and succeeds on second attempt", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw apiError(429, "Rate limited");
        return textResult("Success after retry");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("Success after retry");
    expect(callCount).toBe(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(429, expect.any(Number));
  });

  it("retries on 529 (overloaded)", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw apiError(529, "Overloaded");
        return textResult("OK");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("OK");
    expect(onRetry).toHaveBeenCalledWith(529, expect.any(Number));
  });

  it("retries on network errors (status 0)", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw networkError();
        return textResult("Reconnected");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("Reconnected");
    expect(onRetry).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it("throws after maxRetries exhausted", async () => {
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => { throw apiError(429, "Always rate limited"); }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      maxRetries: 2,
      onRetry,
    });

    // Catch the rejection early to avoid unhandled rejection warning,
    // then advance timers and assert the error.
    let caughtError: Error | undefined;
    promise.catch((e: Error) => { caughtError = e; });

    // Advance through both retry delays (1s + 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    // Let the final rejection settle
    await vi.advanceTimersByTimeAsync(0);

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("Always rate limited");

    // 2 retries (attempts 0 and 1 trigger onRetry; attempt 2 exceeds maxRetries and throws)
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("retries indefinitely by default (no maxRetries cap)", async () => {
    // Regression: an earlier default of maxRetries=5 caused the engine to give
    // up after ~27s of backoff during a network outage, silently dropping the
    // retry modal and stranding the player. The spec promises indefinite
    // retry; this test pins the default by exercising more failures than the
    // old cap would have permitted.
    const FAILURES_BEFORE_RECOVERY = 10;
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount <= FAILURES_BEFORE_RECOVERY) throw networkError();
        return textResult("Reconnected");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
      // Note: no maxRetries — use the default.
    });

    // Step through one pending timer at a time rather than baking in the
    // current backoff schedule (1,2,4,8,12,…) — that decouples the test from
    // the exact `retryDelay()` curve so future tuning of the backoff doesn't
    // break this test even though the "no default cap" behavior is unchanged.
    // Bounded loop in case the implementation regresses and stops scheduling.
    for (let i = 0; i < FAILURES_BEFORE_RECOVERY * 2; i++) {
      if (callCount > FAILURES_BEFORE_RECOVERY) break;
      await vi.advanceTimersToNextTimerAsync();
    }
    const result = await promise;

    expect(result.text).toBe("Reconnected");
    expect(callCount).toBe(FAILURES_BEFORE_RECOVERY + 1);
    expect(onRetry).toHaveBeenCalledTimes(FAILURES_BEFORE_RECOVERY);
  });

  it("does not retry non-retryable errors (400)", async () => {
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => { throw apiError(400, "Bad request"); }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    await expect(runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
    })).rejects.toThrow("Bad request");

    expect(onRetry).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalledOnce();
  });

  it("does not retry errors without HTTP status (e.g. ContentRefusalError)", async () => {
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => { throw new Error("Content refusal"); }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    await expect(runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRetry,
    })).rejects.toThrow("Content refusal");

    expect(onRetry).not.toHaveBeenCalled();
  });

  it("works without onRetry callback (silent retry for subagents)", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw apiError(503, "Service unavailable");
        return textResult("OK");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    // No onRetry callback — subagents and resolve-session don't pass one
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("OK");
    expect(callCount).toBe(2);
  });

  it("retries streaming calls", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) throw apiError(502, "Bad gateway");
        const result = textResult("Streamed OK");
        onDelta(result.text);
        return result;
      }),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const onTextDelta = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("Streamed OK");
    expect(onRetry).toHaveBeenCalledWith(502, expect.any(Number));
  });

  // The rollback signal exists for issue #431: a streaming call that emits
  // partial deltas before failing leaves those deltas accumulated on the
  // client. Without onRollback, the retry would re-stream from scratch and
  // visibly duplicate the text. The signal lets the consumer publish a
  // corrective snapshot before the retry begins.
  it("fires onRollback when a partial stream fails before retrying", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          // Emit some deltas, then fail — simulates the actual bug shape.
          onDelta("The bell ");
          onDelta("chimes. Mollie ");
          throw apiError(502, "Bad gateway");
        }
        const result = textResult("The bell chimes. Mollie glances up.");
        onDelta(result.text);
        return result;
      }),
      healthCheck: vi.fn(),
    };

    const onRetry = vi.fn();
    const onRollback = vi.fn();
    const onTextDelta = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      onRetry,
      onRollback,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("The bell chimes. Mollie glances up.");
    // Critical ordering: rollback must fire before retry, so the corrective
    // snapshot lands before the next attempt's deltas start arriving.
    expect(onRollback).toHaveBeenCalledOnce();
    const rollbackOrder = onRollback.mock.invocationCallOrder[0];
    const retryOrder = onRetry.mock.invocationCallOrder[0];
    expect(rollbackOrder).toBeLessThan(retryOrder);
  });

  it("does NOT fire onRollback when stream fails before emitting any delta", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) throw apiError(529, "Overloaded");
        const result = textResult("OK");
        onDelta(result.text);
        return result;
      }),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta: vi.fn(),
      onRollback,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Nothing leaked to the client, so no rollback needed — avoids a
    // pointless snapshot round-trip on every transient pre-stream failure.
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("does NOT fire onRollback for non-streaming retries", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw apiError(503, "Service unavailable");
        return textResult("OK");
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      onRollback,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Non-streaming responses are emitted as a single onTextDelta on success
    // only. A failed non-streaming attempt has no partial output to roll back.
    expect(onRollback).not.toHaveBeenCalled();
  });
});

// Round-boundary handling: when the model emits narrative text alongside a
// tool call (especially a deferred TUI tool that doesn't broadcast on its
// own), Claude can re-narrate the same content after the tool_result. The
// loop must (a) keep result.text aligned with the final assistant message,
// not the running concatenation, and (b) tell consumers to roll back the
// streamed deltas from the prior round before the next round's stream
// begins, so the live UI doesn't show the response twice.
describe("runProviderLoop with internal-dispatch providers", () => {
  // Codex (openai-chatgpt) dispatches tool calls in-band during the turn
  // via params.dispatchTool. It MUST NOT re-surface those calls through
  // ChatResult.toolCalls, or the bridge will run every write_entity /
  // scribe write twice — the symptom that wrecked route-0's character
  // sheets (duplicated changelog entries, duplicated body paragraphs,
  // duplicated frontmatter mutations).
  it("does not re-dispatch tool calls when provider used internal dispatch", async () => {
    const handlerCalls: { name: string; input: Record<string, unknown> }[] = [];
    const provider: LLMProvider = {
      providerId: "test-internal-dispatch",
      chat: vi.fn(async (params) => {
        // Simulate codex's internal dispatch: provider invokes
        // params.dispatchTool itself during the turn.
        if (params.tools && params.dispatchTool) {
          await params.dispatchTool({
            id: "call_1",
            name: "write_entity",
            input: { name: "Janey" },
          });
        }
        return {
          text: "ok",
          // Critical: an internal-dispatch provider returns no surfaced
          // tool calls; the bridge would otherwise re-run the handler.
          toolCalls: [],
          usage: mockUsage(),
          stopReason: "end" as const,
          assistantContent: [
            { type: "tool_use", id: "call_1", name: "write_entity", input: { name: "Janey" } },
            { type: "text", text: "ok" },
          ],
        };
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    await runProviderLoop(provider, "system", [
      { role: "user", content: "do it" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: false,
      tools: [{ name: "write_entity", description: "", inputSchema: { type: "object", properties: {} } }],
      toolHandler: (name, input) => {
        handlerCalls.push({ name, input });
        return { content: "wrote" };
      },
    });

    // Exactly one invocation — the internal-dispatch call. If the bridge
    // re-dispatched result.toolCalls, this would be 2.
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]).toEqual({ name: "write_entity", input: { name: "Janey" } });
  });
});

describe("runProviderLoop round-boundary rollback", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns only the final round's text, not the accumulation", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          // Model speaks, then calls a deferred TUI tool.
          const r = textPlusToolResult("Round one narrative.", "scribe");
          onDelta(r.text);
          return r;
        }
        // Model re-narrates after seeing the tool_result.
        const r = textResult("Round one narrative.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    const onTextDelta = vi.fn();
    const result = await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      toolHandler: () => ({ content: "ok" }),
    });

    // Without last-round-wins, fullText would be "Round one narrative.Round
    // one narrative." — the bug from the playtester report.
    expect(result.text).toBe("Round one narrative.");
    expect(callCount).toBe(2);
  });

  it("fires a post-loop corrective onRollback when the model regenerates", async () => {
    // Regen case: the model emits the same narrative both before and after
    // the deferred tool_result, despite the "narrative delivered" suffix.
    // The bridge collapses to one canonical copy (last-wins) and tells the
    // client to discard the doubled stream + replay the canonical text.
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          const r = textPlusToolResult("Round one narrative.", "scribe");
          onDelta(r.text);
          return r;
        }
        const r = textResult("Round one narrative.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const deltas: string[] = [];
    const result = await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta: (d) => deltas.push(d),
      onRollback,
      toolHandler: () => ({ content: "ok" }),
    });

    expect(result.text).toBe("Round one narrative.");
    expect(onRollback).toHaveBeenCalledOnce();
    // After the rollback, the canonical text is replayed as a single delta so
    // the client redraws what we actually persist.
    expect(deltas.at(-1)).toBe("Round one narrative.");
  });

  it("concatenates a genuine continuation across rounds (#485)", async () => {
    // Continuation case: the model takes the "unless you have new narrative
    // to add" hint at face value and writes a coda after the deferred tool.
    // The bridge must concatenate (not discard) — that's the entire reason
    // we replaced the old last-wins-always rule.
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          const r = textPlusToolResult("Round one narrative.", "scribe");
          onDelta(r.text);
          return r;
        }
        const r = textResult("Round two coda.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const onTextDelta = vi.fn();
    const result = await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      onRollback,
      toolHandler: () => ({ content: "ok" }),
    });

    expect(result.text).toBe("Round one narrative.Round two coda.");
    // No rollback — the client's accumulated stream already matches the
    // persisted text, so a corrective snapshot would be a pointless flash.
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("does NOT fire onRollback when the prior round emitted no text", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          // Tool-only round — no narrative text. (The common case: model
          // calls a tool, gets the result, then narrates.)
          return textPlusToolResult("", "roll_dice");
        }
        const r = textResult("You rolled a 17.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const onTextDelta = vi.fn();
    await runProviderLoop(provider, "system", [
      { role: "user", content: "Roll" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      onRollback,
      toolHandler: () => ({ content: "17" }),
    });

    // Nothing leaked from round 1, so a corrective snapshot would be a
    // pointless round-trip — same reasoning as the pre-stream-failure case.
    expect(onRollback).not.toHaveBeenCalled();
  });

  // Deferred TUI tools (scribe / scene_transition / dm_notes /
  // promote_character / session_end) execute server-side after the agent
  // loop returns, so their tool_result is just a queue confirmation. The
  // bridge appends a uniform "narrative was delivered" signal so the model
  // doesn't ambiguously interpret the ack and re-narrate.
  it("appends the narrative-delivered suffix to deferred TUI tool results", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          const r = textPlusToolResult("Some narrative.", "scribe");
          onDelta(r.text);
          return r;
        }
        // Capture is on round 2's messages — tool_result is in there.
        const r = textResult("Done.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      tuiToolNames: new Set(["scribe"]),
      onTextDelta: vi.fn(),
      toolHandler: () => ({
        content: "Scribe queued: 2 update(s)",
        _tui: { type: "scribe", updates: [] },
      }),
    });

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const round2Messages = streamCalls[1][0].messages;
    const toolResultMsg = round2Messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && Array.isArray(m.content),
    ) as { content: ContentPart[] } | undefined;
    const toolResultBlock = toolResultMsg?.content.find(
      (b) => b.type === "tool_result",
    );

    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock?.content).toContain("Scribe queued: 2 update(s)");
    expect(toolResultBlock?.content).toContain("delivered to the player");
    expect(toolResultBlock?.content).toContain("End your turn");
  });

  it("does NOT append the suffix to non-deferred TUI tools", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          // update_modeline is a TUI tool but not in DEFERRED_TUI_TYPES —
          // it's broadcast immediately and the model often continues
          // narrating mid-turn, so the "end your turn" signal would
          // actively mislead.
          const r = textPlusToolResult("Mid-narrative.", "update_modeline");
          onDelta(r.text);
          return r;
        }
        const r = textResult("Continued.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      tuiToolNames: new Set(["update_modeline"]),
      onTextDelta: vi.fn(),
      toolHandler: () => ({
        content: "Modeline updated.",
        _tui: { type: "update_modeline", character: "Adrian", text: "..." },
      }),
    });

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const round2Messages = streamCalls[1][0].messages;
    const toolResultMsg = round2Messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && Array.isArray(m.content),
    ) as { content: ContentPart[] } | undefined;
    const toolResultBlock = toolResultMsg?.content.find(
      (b) => b.type === "tool_result",
    );

    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock?.content).toBe("Modeline updated.");
    expect(toolResultBlock?.content).not.toContain("delivered to the player");
  });

  it("does NOT append the suffix when the deferred tool errored", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          const r = textPlusToolResult("", "scribe");
          return r;
        }
        const r = textResult("Recovered.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    await runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      tuiToolNames: new Set(["scribe"]),
      onTextDelta: vi.fn(),
      toolHandler: () => ({
        content: "Scribe failed: invalid update",
        is_error: true,
        _tui: { type: "scribe", updates: [] },
      }),
    });

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const round2Messages = streamCalls[1][0].messages;
    const toolResultMsg = round2Messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && Array.isArray(m.content),
    ) as { content: ContentPart[] } | undefined;
    const toolResultBlock = toolResultMsg?.content.find(
      (b) => b.type === "tool_result",
    );

    // Errors stay clean so the model sees the actual failure, not a
    // diluted version mixed with end-your-turn boilerplate.
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock?.is_error).toBe(true);
    expect(toolResultBlock?.content).toBe("Scribe failed: invalid update");
  });

  it("fires both per-attempt and post-loop rollbacks when both apply", async () => {
    // Same round-1 retry path as before, but round 2 regenerates round 1's
    // text (instead of continuing) so the post-loop corrective rollback also
    // fires. The two rollbacks address distinct duplication sources: a
    // failed mid-stream attempt vs. the model re-narrating after the tool.
    let callCount = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(),
      stream: vi.fn(async (_params, onDelta) => {
        callCount++;
        if (callCount === 1) {
          // Round 1, attempt 1: partial stream then 502 → per-attempt rollback.
          onDelta("Round one ");
          throw apiError(502, "Bad gateway");
        }
        if (callCount === 2) {
          // Round 1, attempt 2: success, with text + tool call.
          const r = textPlusToolResult("Round one narrative.", "scribe");
          onDelta(r.text);
          return r;
        }
        // Round 2: model re-narrates verbatim → post-loop corrective rollback.
        const r = textResult("Round one narrative.");
        onDelta(r.text);
        return r;
      }),
      healthCheck: vi.fn(),
    };

    const onRollback = vi.fn();
    const onTextDelta = vi.fn();
    const promise = runProviderLoop(provider, "system", [
      { role: "user", content: "hello" },
    ], {
      name: "test",
      model: "test-model",
      maxTokens: 100,
      stream: true,
      onTextDelta,
      onRollback,
      toolHandler: () => ({ content: "ok" }),
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.text).toBe("Round one narrative.");
    // One for the failed attempt's partial leak, one for the post-loop
    // regen collapse. Both are necessary: the first protects against retry
    // duplication, the second against re-narration duplication.
    expect(onRollback).toHaveBeenCalledTimes(2);
  });
});
