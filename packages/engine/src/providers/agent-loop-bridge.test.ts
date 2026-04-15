import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "./types.js";
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
});
