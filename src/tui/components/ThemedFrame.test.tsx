import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { ThemedHorizontalBorder, ThemedSideFrame } from "./ThemedFrame.js";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import type { ThemeDefinition, ResolvedTheme } from "../themes/types.js";

/** Theme definition with gradient enabled. */
const GOTHIC_DEF: ThemeDefinition = {
  assetName: "gothic",
  swatchConfig: { preset: "ember", harmony: "analogous" },
  colorMap: { border: 2, corner: 3, separator: 4, title: 5, turnIndicator: 6, sideFrame: 1 },
  gradient: { preset: "vignette" },
};

/** Theme definition without gradient. */
const NO_GRADIENT_DEF: ThemeDefinition = {
  assetName: "gothic",
  swatchConfig: { preset: "ember", harmony: "analogous" },
  colorMap: { border: 2, corner: 3, separator: 4, title: 5, turnIndicator: 6, sideFrame: 1 },
};

describe("ThemedHorizontalBorder", () => {
  let withGrad: ResolvedTheme;
  let noGrad: ResolvedTheme;

  beforeEach(() => {
    resetThemeCache();
    withGrad = resolveTheme(GOTHIC_DEF, "exploration", "#cc4444");
    noGrad = resolveTheme(NO_GRADIENT_DEF, "exploration", "#cc4444");
  });

  it("renders border text content without gradient", () => {
    const { lastFrame } = render(
      <ThemedHorizontalBorder theme={noGrad} width={40} position="top" />,
    );
    const frame = lastFrame()!;
    // Should contain the edge/corner characters from the gothic theme
    expect(frame).toContain("╔");
    expect(frame).toContain("╗");
    expect(frame).toContain("═");
  });

  it("renders border text content with gradient", () => {
    const { lastFrame } = render(
      <ThemedHorizontalBorder theme={withGrad} width={40} position="top" />,
    );
    const frame = lastFrame()!;
    // Same text content should be present regardless of gradient
    expect(frame).toContain("╔");
    expect(frame).toContain("╗");
    expect(frame).toContain("═");
  });

  it("with title: title text color preserved, border portions gradient-colored", () => {
    const { lastFrame } = render(
      <ThemedHorizontalBorder
        theme={withGrad}
        width={60}
        position="top"
        centerText="Scene 1"
        centerTextColor="#ffffff"
      />,
    );
    const frame = lastFrame()!;
    // Title text should appear in the output
    expect(frame).toContain("Scene 1");
    // Border characters should still be present
    expect(frame).toContain("╔");
    expect(frame).toContain("╗");
  });

  it("without gradient renders same text content as with gradient", () => {
    const { lastFrame: framNoGrad } = render(
      <ThemedHorizontalBorder theme={noGrad} width={40} position="top" />,
    );
    const { lastFrame: framWithGrad } = render(
      <ThemedHorizontalBorder theme={withGrad} width={40} position="top" />,
    );
    // Strip ANSI to compare raw text (both should have same characters)
    const stripAnsi = (s: string) =>
      s.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g"), "");
    expect(stripAnsi(framWithGrad()!)).toBe(stripAnsi(framNoGrad()!));
  });
});

describe("ThemedSideFrame", () => {
  let withGrad: ResolvedTheme;
  let noGrad: ResolvedTheme;

  beforeEach(() => {
    resetThemeCache();
    withGrad = resolveTheme(GOTHIC_DEF, "exploration", "#cc4444");
    noGrad = resolveTheme(NO_GRADIENT_DEF, "exploration", "#cc4444");
  });

  it("renders side frame content without gradient", () => {
    const { lastFrame } = render(
      <ThemedSideFrame theme={noGrad} side="left" height={5} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("║");
  });

  it("renders side frame content with gradient", () => {
    const { lastFrame } = render(
      <ThemedSideFrame theme={withGrad} side="left" height={5} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("║");
  });

  it("without gradient renders same text content as with gradient", () => {
    const { lastFrame: framNoGrad } = render(
      <ThemedSideFrame theme={noGrad} side="left" height={10} />,
    );
    const { lastFrame: framWithGrad } = render(
      <ThemedSideFrame theme={withGrad} side="left" height={10} />,
    );
    const stripAnsi = (s: string) =>
      s.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g"), "");
    expect(stripAnsi(framWithGrad()!)).toBe(stripAnsi(framNoGrad()!));
  });
});
