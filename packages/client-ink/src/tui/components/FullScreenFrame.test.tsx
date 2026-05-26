import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { FullScreenFrame } from "./FullScreenFrame.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../themes/index.js";

beforeEach(() => {
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

  describe("topBanner slot (#529)", () => {
    // The banner lives in the top-padding region — its whole point is to
    // surface high-priority info (auth expired, fatal session error)
    // without shifting the centered children around when it toggles.
    function rowOfFirstMatch(frame: string, marker: string): number {
      const lines = frame.split("\n");
      return lines.findIndex((l) => l.includes(marker));
    }

    it("renders topBanner content above the centered children", () => {
      const theme = makeTheme();
      const banner = <Text>BANNER_MARKER</Text>;
      const { lastFrame } = render(
        <FullScreenFrame
          theme={theme}
          columns={80}
          rows={24}
          contentRows={1}
          topBanner={banner}
          topBannerRows={1}
        >
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      );
      const frame = lastFrame() ?? "";
      expect(frame).toContain("BANNER_MARKER");
      expect(frame).toContain("CHILD_MARKER");
      expect(rowOfFirstMatch(frame, "BANNER_MARKER"))
        .toBeLessThan(rowOfFirstMatch(frame, "CHILD_MARKER"));
    });

    it("keeps centered children at the same row whether or not the banner is present", () => {
      // This is the whole reason the slot exists: out-of-band messages
      // must not cause UI jitter when they appear/disappear. Render the
      // same children at the same `contentRows` with and without a
      // 3-row banner; the child row index must be identical.
      const theme = makeTheme();
      const without = render(
        <FullScreenFrame theme={theme} columns={80} rows={24} contentRows={1}>
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      ).lastFrame() ?? "";
      const withBanner = render(
        <FullScreenFrame
          theme={theme}
          columns={80}
          rows={24}
          contentRows={1}
          topBanner={
            <>
              <Text>BAN1</Text>
              <Text>BAN2</Text>
              <Text>BAN3</Text>
            </>
          }
          topBannerRows={3}
        >
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      ).lastFrame() ?? "";
      expect(rowOfFirstMatch(without, "CHILD_MARKER"))
        .toBe(rowOfFirstMatch(withBanner, "CHILD_MARKER"));
    });

    it("renders the banner even when topBannerRows is omitted (Copilot review)", () => {
      // The previous gating (`topBanner != null && topBannerRows > 0`)
      // silently dropped the banner if a caller forgot the rows prop —
      // an easy API footgun. Render whenever provided; rows is a
      // layout-preservation hint, not a render gate.
      const theme = makeTheme();
      const frame = render(
        <FullScreenFrame
          theme={theme}
          columns={80}
          rows={24}
          contentRows={1}
          topBanner={<Text>BANNER_MARKER</Text>}
        >
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      ).lastFrame() ?? "";
      expect(frame).toContain("BANNER_MARKER");
      // Banner is above the child (layout-preservation is the caller's
      // responsibility when rows is omitted).
      expect(rowOfFirstMatch(frame, "BANNER_MARKER"))
        .toBeLessThan(rowOfFirstMatch(frame, "CHILD_MARKER"));
    });

    it("omits banner space when topBanner is null", () => {
      // Skip the slot's reservation entirely when there's nothing to show
      // (don't leave a phantom gap above the menu).
      const theme = makeTheme();
      const frame = render(
        <FullScreenFrame
          theme={theme}
          columns={80}
          rows={24}
          contentRows={1}
          topBanner={null}
          topBannerRows={3}
        >
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      ).lastFrame() ?? "";
      const baseline = render(
        <FullScreenFrame theme={theme} columns={80} rows={24} contentRows={1}>
          <Text>CHILD_MARKER</Text>
        </FullScreenFrame>,
      ).lastFrame() ?? "";
      expect(rowOfFirstMatch(frame, "CHILD_MARKER"))
        .toBe(rowOfFirstMatch(baseline, "CHILD_MARKER"));
    });
  });
});
