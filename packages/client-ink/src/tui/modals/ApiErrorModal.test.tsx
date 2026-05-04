import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { ApiErrorModal } from "./ApiErrorModal.js";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import { BUILTIN_DEFINITIONS } from "../themes/builtin-definitions.js";

let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

describe("ApiErrorModal", () => {
  it("renders title, status label, and countdown for 429", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 429, delaySec: 10, attemptId: 1 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Connection Error");
    expect(frame).toContain("Rate limited");
    expect(frame).toContain("Retrying in 10s...");
    expect(frame).toContain("auto-resume");
  });

  it("renders status label for 529 (API overloaded)", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 529, delaySec: 30, attemptId: 1 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("API overloaded");
    expect(frame).toContain("Retrying in 30s...");
  });

  it("renders status label for 0 (connection lost)", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 0, delaySec: 5, attemptId: 1 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Connection lost");
    expect(frame).toContain("Retrying in 5s...");
  });

  it("renders generic status label for 500", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 500, delaySec: 15, attemptId: 1 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("API error (500)");
    expect(frame).toContain("Retrying in 15s...");
  });

  describe("countdown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("ticks down once per second", async () => {
      const { lastFrame } = render(
        <Box width={60} height={24}>
          <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 529, delaySec: 5, attemptId: 1 }} />
        </Box>,
      );
      expect(lastFrame()).toContain("Retrying in 5s...");

      await vi.advanceTimersByTimeAsync(2000);
      expect(lastFrame()).toContain("Retrying in 3s...");

      await vi.advanceTimersByTimeAsync(10_000);
      // Clamps at 0 — never goes negative.
      expect(lastFrame()).toContain("Retrying in 0s...");
    });

    it("resets countdown when attemptId changes (identical status/delaySec)", async () => {
      // Regression: backoff caps at 12s, so successive retries arrive with
      // identical status/delaySec. Without attemptId in the effect deps, the
      // timer would freeze at 0 forever even as the engine kept retrying.
      const { lastFrame, rerender } = render(
        <Box width={60} height={24}>
          <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 529, delaySec: 12, attemptId: 1 }} />
        </Box>,
      );

      await vi.advanceTimersByTimeAsync(15_000);
      expect(lastFrame()).toContain("Retrying in 0s...");

      // Same status, same delay — only attemptId differs (new retry attempt).
      rerender(
        <Box width={60} height={24}>
          <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 529, delaySec: 12, attemptId: 2 }} />
        </Box>,
      );
      // Flush the post-rerender effect so the timer reset is observable.
      await vi.advanceTimersByTimeAsync(0);

      expect(lastFrame()).toContain("Retrying in 12s...");
    });
  });
});
