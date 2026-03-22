import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { FullScreenFrame } from "./FullScreenFrame.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../themes/index.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

describe("FullScreenFrame", () => {
  it("renders title in top border", () => {
    const theme = makeTheme();
    const { lastFrame } = render(
      <FullScreenFrame theme={theme} columns={80} rows={24} title="Test Title" contentRows={1}>
        <Text>Hello</Text>
      </FullScreenFrame>,
    );
    expect(lastFrame()).toContain("Test Title");
  });

  it("renders children content", () => {
    const theme = makeTheme();
    const { lastFrame } = render(
      <FullScreenFrame theme={theme} columns={80} rows={24} title="Menu" contentRows={2}>
        <Text>Item One</Text>
        <Text>Item Two</Text>
      </FullScreenFrame>,
    );
    expect(lastFrame()).toContain("Item One");
    expect(lastFrame()).toContain("Item Two");
  });

  it("renders without title", () => {
    const theme = makeTheme();
    const { lastFrame } = render(
      <FullScreenFrame theme={theme} columns={80} rows={24} contentRows={1}>
        <Text>Content</Text>
      </FullScreenFrame>,
    );
    expect(lastFrame()).toContain("Content");
  });
});
