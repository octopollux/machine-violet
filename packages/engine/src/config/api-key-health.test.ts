import { describe, it, expect } from "vitest";
import { formatHealthStatus, formatRateLimits } from "./api-key-health.js";
import type { KeyHealthResult, RateLimitInfo } from "./api-key-health.js";

describe("formatHealthStatus", () => {
  it("formats valid status", () => {
    const result: KeyHealthResult = { status: "valid", message: "Key is valid", checkedAt: "" };
    expect(formatHealthStatus(result)).toBe("Valid");
  });

  it("formats invalid status", () => {
    const result: KeyHealthResult = { status: "invalid", message: "Invalid API key", checkedAt: "" };
    expect(formatHealthStatus(result)).toBe("Invalid");
  });

  it("formats error status with message", () => {
    const result: KeyHealthResult = { status: "error", message: "Connection refused", checkedAt: "" };
    expect(formatHealthStatus(result)).toBe("Error: Connection refused");
  });

  it("formats rate_limited status", () => {
    const result: KeyHealthResult = { status: "rate_limited", message: "", checkedAt: "" };
    expect(formatHealthStatus(result)).toBe("Rate limited");
  });

  it("formats checking status", () => {
    const result: KeyHealthResult = { status: "checking", message: "", checkedAt: "" };
    expect(formatHealthStatus(result)).toBe("Checking...");
  });
});

describe("formatRateLimits", () => {
  it("formats both requests and tokens", () => {
    const info: RateLimitInfo = {
      requestsLimit: 100,
      requestsRemaining: 80,
      tokensLimit: 4_000_000,
      tokensRemaining: 2_500_000,
    };
    expect(formatRateLimits(info)).toBe("80/100 req · 2.5M/4M tok");
  });

  it("handles tokens only", () => {
    const info: RateLimitInfo = {
      tokensLimit: 1_000_000,
      tokensRemaining: 500_000,
    };
    expect(formatRateLimits(info)).toBe("500k/1M tok");
  });

  it("returns fallback when no data", () => {
    expect(formatRateLimits({})).toBe("No rate limit data");
  });
});
