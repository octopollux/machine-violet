import React from "react";
import { Text } from "ink";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { GameProvider, useGameContext } from "./game-context.js";
import type { GameContextValue } from "./game-context.js";

/** Builds a minimal GameContextValue for tests. Override any field via `overrides`. */
export function makeTestContext(overrides: Partial<GameContextValue> = {}): GameContextValue {
  return {
    engineRef: { current: null },
    gameStateRef: { current: null },
    clientRef: { current: null },
    costTracker: { current: { formatTokens: () => "", record: vi.fn() } as never },
    narrativeLines: [],
    setNarrativeLines: vi.fn(),
    theme: {
      asset: { name: "test", genreTags: [], height: 1, components: {} },
      playerPaneFrame: { name: "test", components: {} },
      swatch: [],
      colorMap: { border: 0, corner: 0, separator: 0, title: 0, turnIndicator: 0, sideFrame: 0 },
      variant: "exploration",
      keyColor: "#888888",
    } as never,
    variant: "exploration",
    setVariant: vi.fn(),
    setTheme: vi.fn(),
    keyColor: "#888888",
    setKeyColor: vi.fn(),
    campaignName: "Test Campaign",
    activePlayerIndex: 0,
    setActivePlayerIndex: vi.fn(),
    engineState: null,
    toolGlyphs: [],
    resources: [],
    modelines: {},
    activeModal: null,
    setActiveModal: vi.fn(),
    activeSession: null,
    setActiveSession: vi.fn(),
    previousVariantRef: { current: "exploration" },
    devModeEnabled: false,
    dispatchTuiCommand: vi.fn(),
    retryOverlay: null,
    onReturnToMenu: vi.fn(),
    onRollbackReturn: vi.fn(),
    onEndSessionAndReturn: vi.fn(),
    ...overrides,
  };
}

/** Test component that renders a field from context. */
function ShowCampaign() {
  const { campaignName } = useGameContext();
  return <Text>{campaignName}</Text>;
}

describe("GameContext", () => {
  it("returns context value when inside provider", () => {
    const ctx = makeTestContext({ campaignName: "My Quest" });
    const { lastFrame } = render(
      <GameProvider value={ctx}>
        <ShowCampaign />
      </GameProvider>,
    );
    expect(lastFrame()).toContain("My Quest");
  });

  it("throws when used outside provider", () => {
    // Ink's render catches the throw internally, so we capture via an error boundary
    let caught: Error | null = null;

    function Bomb() {
      useGameContext(); // should throw
      return <Text>should not render</Text>;
    }

    class Catcher extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
      state = { error: false };
      static getDerivedStateFromError() { return { error: true }; }
      componentDidCatch(err: Error) { caught = err; }
      render() { return this.state.error ? null : this.props.children; }
    }

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Catcher><Bomb /></Catcher>);
    spy.mockRestore();

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("useGameContext must be used within a <GameProvider>");
  });
});
