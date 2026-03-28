import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useTerminalSize } from "./useTerminalSize.js";

function SizeDisplay() {
  const { columns, rows } = useTerminalSize();
  return React.createElement(Text, null, `${columns}x${rows}`);
}

describe("useTerminalSize", () => {
  it("returns default dimensions from stdout", () => {
    const { lastFrame } = render(React.createElement(SizeDisplay));
    const frame = lastFrame()!;
    // ink-testing-library provides a default stdout; exact values vary
    // but the hook should produce a parseable "NxN" string
    expect(frame).toMatch(/\d+x\d+/);
  });
});
