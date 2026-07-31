import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { SettingsPhase } from "./SettingsPhase.js";
import type { SettingsPhaseProps } from "./SettingsPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";
import { APP_VERSION } from "../version.js";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<SettingsPhaseProps>): SettingsPhaseProps {
  return {
    theme: makeTheme(),
    onConnections: vi.fn(),
    onDiscord: vi.fn(),
    onArchivedCampaigns: vi.fn(),
    onExportDiagnostics: vi.fn(async () => "/home/diagnostics/machine-violet.mvdiag"),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function moveToExportDiagnostics(stdin: { write: (data: string) => void }): Promise<void> {
  for (let i = 0; i < 3; i++) {
    stdin.write("\u001B[B");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("SettingsPhase", () => {
  it("renders Settings title in top border", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Settings");
  });

  it("renders the Connect to AI menu item", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Connect to AI");
  });

  it("renders an Export Diagnostics menu item", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Export Diagnostics");
  });

  it("calls onBack on ESC", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<SettingsPhase {...defaultProps({ onBack })} />);
    stdin.write("\u001B"); // ESC
    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it("calls onConnections when Connect to AI is selected", () => {
    const onConnections = vi.fn();
    const { stdin } = render(<SettingsPhase {...defaultProps({ onConnections })} />);
    stdin.write("\r"); // Enter on the first item
    expect(onConnections).toHaveBeenCalled();
  });

  it("renders the standard key-hint footer", () => {
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("↑↓ select · Enter open · Esc back");
  });

  it("exports diagnostics and displays the saved path", async () => {
    const onExportDiagnostics = vi.fn(async () => "/home/diagnostics/machine-violet.mvdiag");
    const { stdin, lastFrame } = render(
      <SettingsPhase {...defaultProps({ onExportDiagnostics })} />,
    );
    await moveToExportDiagnostics(stdin);
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(onExportDiagnostics).toHaveBeenCalledTimes(1);
      expect(lastFrame()).toContain("Diagnostics saved: /home/diagnostics/machine-violet.mvdiag");
    });
  });

  it("displays a diagnostics export failure", async () => {
    const onExportDiagnostics = vi.fn(async () => {
      throw new Error("debug folder unavailable");
    });
    const { stdin, lastFrame } = render(
      <SettingsPhase {...defaultProps({ onExportDiagnostics })} />,
    );
    await moveToExportDiagnostics(stdin);
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Diagnostics failed: debug folder unavailable");
    });
  });

  it("ignores repeated export input while a bundle is in progress", async () => {
    let resolveExport!: (path: string) => void;
    const onExportDiagnostics = vi.fn(() => new Promise<string>((resolve) => {
      resolveExport = resolve;
    }));
    const { stdin, lastFrame } = render(
      <SettingsPhase {...defaultProps({ onExportDiagnostics })} />,
    );
    await moveToExportDiagnostics(stdin);
    stdin.write("\r");
    stdin.write("\r");

    expect(onExportDiagnostics).toHaveBeenCalledTimes(1);
    resolveExport("/home/diagnostics/machine-violet.mvdiag");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Diagnostics saved");
    });
  });

  it("renders a version label pinned to the bottom-left", () => {
    // Read APP_VERSION at runtime so the test is robust to whatever
    // MV_VERSION/MV_RELEASE_DATE the environment happens to have set.
    const { lastFrame } = render(<SettingsPhase {...defaultProps()} />);
    expect(lastFrame()).toContain(`v${APP_VERSION}`);
  });
});
