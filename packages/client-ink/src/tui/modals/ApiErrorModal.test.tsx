import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach } from "vitest";
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
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 429, delaySec: 10 }} />
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
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 529, delaySec: 30 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("API overloaded");
    expect(frame).toContain("Retrying in 30s...");
  });

  it("renders status label for 0 (connection lost)", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 0, delaySec: 5 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("Connection lost");
    expect(frame).toContain("Retrying in 5s...");
  });

  it("renders generic status label for 500", () => {
    const { lastFrame } = render(
      <Box width={60} height={24}>
        <ApiErrorModal theme={theme} width={60} height={24} overlay={{ status: 500, delaySec: 15 }} />
      </Box>,
    );
    const frame = lastFrame();
    expect(frame).toContain("API error (500)");
    expect(frame).toContain("Retrying in 15s...");
  });
});
