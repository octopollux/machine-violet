import React from "react";
import { Box } from "ink";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "ink-testing-library";
import { CampaignSettingsModal } from "./CampaignSettingsModal.js";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
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

function renderModal(config: CampaignConfig, onFreq?: (v: string) => void) {
  const theme = makeTheme();
  return render(
    <Box width={80} height={30}>
      <CampaignSettingsModal
        theme={theme}
        width={80}
        height={30}
        config={config}
        onDismiss={() => {}}
        onChoicesFrequencyChange={onFreq as never}
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

  it("omits optional fields when not set", () => {
    const { lastFrame } = renderModal(minimalConfig());
    const frame = lastFrame();
    expect(frame).not.toContain("System:");
    expect(frame).not.toContain("Genre:");
    expect(frame).not.toContain("Mood:");
    expect(frame).not.toContain("Difficulty:");
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
});
