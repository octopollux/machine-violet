import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { TerminalTooSmall } from "./TerminalTooSmall.js";

describe("TerminalTooSmall", () => {
  it("renders message with current dimensions", () => {
    const { lastFrame } = render(<TerminalTooSmall columns={60} rows={20} />);
    const frame = lastFrame()!;
    expect(frame).toContain("60");
    expect(frame).toContain("20");
    expect(frame).toContain("Terminal Too Small");
  });

  it("shows minimum requirements", () => {
    const { lastFrame } = render(<TerminalTooSmall columns={60} rows={20} />);
    const frame = lastFrame()!;
    expect(frame).toContain("80");
    expect(frame).toContain("25");
    expect(frame).toContain("Minimum required");
  });

  it("shows resize instruction", () => {
    const { lastFrame } = render(<TerminalTooSmall columns={40} rows={15} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Resize your terminal");
  });
});
