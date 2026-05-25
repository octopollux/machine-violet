import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { CampaignSettingsModal } from "./CampaignSettingsModal.js";
import type { CampaignConfig, ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../themes/index.js";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function minimalConfig(overrides?: Partial<CampaignConfig>): CampaignConfig {
  return {
    name: "Test Campaign",
    dm_personality: { name: "Default", prompt_fragment: "" },
    players: [],
    combat: { initiative_method: "fiction_first", round_structure: "side", surprise_rules: false },
    context: { retention_exchanges: 20, max_conversation_tokens: 100000 },
    recovery: { auto_commit_interval: 10, max_commits: 50, enable_git: true },
    choices: { campaign_default: "never", player_overrides: {} },
    ...overrides,
  };
}

function renderModal(
  config: CampaignConfig,
  onFreq?: (v: ChoiceFrequency) => void,
  onPct?: (v: number) => void,
  globalDefault?: number,
) {
  const theme = makeTheme();
  return render(
    <Box width={80} height={30}>
      <CampaignSettingsModal
        theme={theme}
        width={80}
        height={30}
        config={config}
        onDismiss={() => {}}
        onChoicesFrequencyChange={onFreq}
        onDmTurnLengthPctChange={onPct}
        globalDmTurnLengthPctDefault={globalDefault}
      />
    </Box>,
  );
}

describe("CampaignSettingsModal", () => {
  it("displays campaign name", () => {
    const { lastFrame } = renderModal(minimalConfig());
    expect(lastFrame()).toContain("Test Campaign");
  });

  it("displays title", () => {
    const { lastFrame } = renderModal(minimalConfig());
    expect(lastFrame()).toContain("Campaign Settings");
  });

  it("displays system when set", () => {
    const { lastFrame } = renderModal(minimalConfig({ system: "d5e" }));
    expect(lastFrame()).toContain("d5e");
  });

  it("displays genre, mood, and difficulty when set", () => {
    const config = minimalConfig({ genre: "Dark Fantasy", mood: "Grim", difficulty: "Hard" });
    const { lastFrame } = renderModal(config);
    const frame = lastFrame();
    expect(frame).toContain("Dark Fantasy");
    expect(frame).toContain("Grim");
    expect(frame).toContain("Hard");
  });

  it("displays scope label when campaign_scope is set", () => {
    const { lastFrame } = renderModal(minimalConfig({ campaign_scope: "few-sessions" }));
    expect(lastFrame()).toContain("A Few Sessions");
  });

  it("omits optional fields when not set", () => {
    const { lastFrame } = renderModal(minimalConfig());
    const frame = lastFrame();
    expect(frame).not.toContain("System:");
    expect(frame).not.toContain("Genre:");
    expect(frame).not.toContain("Mood:");
    expect(frame).not.toContain("Difficulty:");
    expect(frame).not.toContain("Scope:");
  });

  it("renders the Choices Frequency slider with all five steps", () => {
    const { lastFrame } = renderModal(minimalConfig());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Choices Frequency");
    expect(frame).toContain("Never");
    expect(frame).toContain("Rarely");
    expect(frame).toContain("Sometimes");
    expect(frame).toContain("Often");
    expect(frame).toContain("Always");
  });

  it("highlights the current selection in brackets", () => {
    const config = minimalConfig({
      choices: { campaign_default: "sometimes", player_overrides: {} },
    });
    const { lastFrame } = renderModal(config);
    expect(lastFrame() ?? "").toContain("[Sometimes]");
  });

  it("accepts the legacy 'none' value by treating it as Never", () => {
    const config = minimalConfig({
      choices: { campaign_default: "none" as never, player_overrides: {} },
    });
    const { lastFrame } = renderModal(config);
    expect(lastFrame() ?? "").toContain("[Never]");
  });

  it("moves selection right on →", async () => {
    const onFreq = vi.fn();
    const { stdin, lastFrame } = renderModal(minimalConfig(), onFreq);
    stdin.write("\u001b[C"); // right arrow
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("[Rarely]");
  });

  it("saves the new value on Enter when changed", async () => {
    const onFreq = vi.fn();
    const { stdin } = renderModal(minimalConfig(), onFreq);
    stdin.write("\u001b[C"); // →
    stdin.write("\u001b[C"); // →
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(onFreq).toHaveBeenCalledWith("sometimes");
  });

  it("does not save on Enter if unchanged", async () => {
    const onFreq = vi.fn();
    const { stdin } = renderModal(minimalConfig(), onFreq);
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(onFreq).not.toHaveBeenCalled();
  });

  it("renders the DM Turn Length row with the default 80% when unset", () => {
    const { lastFrame } = renderModal(minimalConfig());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("DM Turn Length");
    expect(frame).toContain("80%");
  });

  it("uses the per-campaign saved value when present", () => {
    const { lastFrame } = renderModal(minimalConfig({ dm_turn_length_pct: 110 }));
    expect(lastFrame() ?? "").toContain("110%");
  });

  it("uses the global client default when the campaign has no saved value", () => {
    const { lastFrame } = renderModal(minimalConfig(), undefined, undefined, 95);
    expect(lastFrame() ?? "").toContain("95%");
  });

  it("adjusts DM Turn Length by 5% on ← / → after ↓ to focus", async () => {
    const onPct = vi.fn();
    const { stdin, lastFrame } = renderModal(minimalConfig(), undefined, onPct);
    stdin.write("[B"); // ↓ — focus length row
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[C"); // → +5
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("85%");
    stdin.write("[C"); // → +5
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("90%");
    stdin.write("[D"); // ← -5
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("85%");
    stdin.write("\r"); // Enter saves
    await new Promise((r) => setTimeout(r, 10));
    expect(onPct).toHaveBeenCalledWith(85);
  });

  it("clamps DM Turn Length to the 50–150 range", async () => {
    const { stdin, lastFrame } = renderModal(minimalConfig({ dm_turn_length_pct: 50 }));
    stdin.write("[B"); // ↓
    await new Promise((r) => setTimeout(r, 10));
    // Already at min — left shouldn't go below 50
    stdin.write("[D"); // ←
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("50%");
    expect(lastFrame() ?? "").not.toContain("45%");
  });

  it("clamps at the upper bound 150", async () => {
    const { stdin, lastFrame } = renderModal(minimalConfig({ dm_turn_length_pct: 150 }));
    stdin.write("[B"); // ↓
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[C"); // → — should not go above 150
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame() ?? "").toContain("150%");
    expect(lastFrame() ?? "").not.toContain("155%");
  });

  it("up arrow returns focus to the Choices Frequency row", async () => {
    const onFreq = vi.fn();
    const onPct = vi.fn();
    const { stdin } = renderModal(minimalConfig(), onFreq, onPct);
    stdin.write("[B"); // ↓ — go to length
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[A"); // ↑ — back to choices
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[C"); // → — should adjust choices, not length
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(onFreq).toHaveBeenCalledWith("rarely");
    expect(onPct).not.toHaveBeenCalled();
  });

  it("saves both fields when both are dirty", async () => {
    const onFreq = vi.fn();
    const onPct = vi.fn();
    const { stdin } = renderModal(minimalConfig(), onFreq, onPct);
    stdin.write("[C"); // → freq
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[B"); // ↓ length
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("[C"); // → length
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(onFreq).toHaveBeenCalledWith("rarely");
    expect(onPct).toHaveBeenCalledWith(85);
  });
});
