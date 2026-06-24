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
  onImages?: (v: "on" | "off") => void,
  onDismiss?: () => void,
) {
  const theme = makeTheme();
  return render(
    <Box width={80} height={30}>
      <CampaignSettingsModal
        theme={theme}
        width={80}
        height={30}
        config={config}
        onDismiss={onDismiss ?? (() => {})}
        onChoicesFrequencyChange={onFreq}
        onDmTurnLengthPctChange={onPct}
        onImageGenerationChange={onImages}
        globalDmTurnLengthPctDefault={globalDefault}
      />
    </Box>,
  );
}

// Real CSI escape sequences. ink's key parser only recognizes an arrow when
// the chunk carries the leading ESC (a bare "[B" is parsed as text, not a
// down-arrow), so these MUST keep the \u001b. Written as explicit escapes —
// not raw control bytes — so they stay visible and greppable in source.
const ESC = "\u001b";
const ARROW = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
} as const;

type Ink = ReturnType<typeof render>;

// Send one key, then wait until the rendered frame satisfies `expectFrame`.
// Anchoring each step on an observable commit — instead of a fixed
// setTimeout — keeps the next keystroke from racing a stale useInput closure
// (ink re-subscribes input on every render). The old fixed-sleep approach is
// what made stepping through multi-row focus flake under load.
async function press(
  stdin: Ink["stdin"],
  lastFrame: Ink["lastFrame"],
  key: string,
  expectFrame: (frame: string) => void,
) {
  stdin.write(key);
  await vi.waitFor(() => expectFrame(lastFrame() ?? ""), { timeout: 2000, interval: 20 });
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
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[Rarely]"));
  });

  it("saves the new value on Enter when changed", async () => {
    const onFreq = vi.fn();
    const { stdin, lastFrame } = renderModal(minimalConfig(), onFreq);
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[Rarely]"));
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[Sometimes]"));
    stdin.write("\r");
    await vi.waitFor(() => expect(onFreq).toHaveBeenCalledWith("sometimes"));
  });

  it("does not save on Enter if unchanged", async () => {
    const onFreq = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = renderModal(minimalConfig(), onFreq, undefined, undefined, undefined, onDismiss);
    stdin.write("\r");
    // Enter on a value row commits; an unchanged commit still dismisses, so
    // dismissal is the observable that Enter was handled without saving.
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalled());
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
    await press(stdin, lastFrame, ARROW.down, (f) => expect(f).toContain("[80%]")); // focus length
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[85%]"));
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[90%]"));
    await press(stdin, lastFrame, ARROW.left, (f) => expect(f).toContain("[85%]"));
    stdin.write("\r"); // Enter saves
    await vi.waitFor(() => expect(onPct).toHaveBeenCalledWith(85));
  });

  it("clamps DM Turn Length to the 50–150 range", async () => {
    const { stdin, lastFrame } = renderModal(minimalConfig({ dm_turn_length_pct: 50 }));
    await press(stdin, lastFrame, ARROW.down, (f) => expect(f).toContain("[50%]")); // focus length
    // Already at min — left shouldn't drop below 50.
    await press(stdin, lastFrame, ARROW.left, (f) => {
      expect(f).toContain("[50%]");
      expect(f).not.toContain("45%");
    });
  });

  it("clamps at the upper bound 150", async () => {
    const { stdin, lastFrame } = renderModal(minimalConfig({ dm_turn_length_pct: 150 }));
    await press(stdin, lastFrame, ARROW.down, (f) => expect(f).toContain("[150%]")); // focus length
    await press(stdin, lastFrame, ARROW.right, (f) => {
      expect(f).toContain("[150%]");
      expect(f).not.toContain("155%");
    });
  });

  it("up arrow returns focus to the Choices Frequency row", async () => {
    const onFreq = vi.fn();
    const onPct = vi.fn();
    const { stdin, lastFrame } = renderModal(minimalConfig(), onFreq, onPct);
    await press(stdin, lastFrame, ARROW.down, (f) => expect(f).toContain("[80%]"));     // focus length
    await press(stdin, lastFrame, ARROW.up, (f) => expect(f).not.toContain("[80%]"));   // back to choices
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[Rarely]")); // adjusts choices, not length
    stdin.write("\r");
    await vi.waitFor(() => expect(onFreq).toHaveBeenCalledWith("rarely"));
    expect(onPct).not.toHaveBeenCalled();
  });

  it("saves both fields when both are dirty", async () => {
    const onFreq = vi.fn();
    const onPct = vi.fn();
    const { stdin, lastFrame } = renderModal(minimalConfig(), onFreq, onPct);
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[Rarely]")); // freq → rarely
    await press(stdin, lastFrame, ARROW.down, (f) => expect(f).toContain("[80%]"));      // focus length
    await press(stdin, lastFrame, ARROW.right, (f) => expect(f).toContain("[85%]"));     // length → 85
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(onFreq).toHaveBeenCalledWith("rarely");
      expect(onPct).toHaveBeenCalledWith(85);
    });
  });

  it("shows Image Generation On for configs without an explicit preference (default-on)", () => {
    const { lastFrame } = renderModal(minimalConfig());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Image Generation");
    expect(frame).toContain("On");
  });

  it("shows Image Generation Off when config.image_generation === \"off\"", () => {
    const { lastFrame } = renderModal(minimalConfig({ image_generation: "off" }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Image Generation");
    expect(frame).toContain("Off");
  });

  it("groups rows under tinted section headers (About / Preferences / Recovery)", () => {
    const { lastFrame } = renderModal(minimalConfig({ system: "Spire" }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("── About");
    expect(frame).toContain("── Preferences");
    expect(frame).toContain("── Recovery");
    // The grouped rows still render under their headers.
    expect(frame).toContain("Choices Frequency");
    expect(frame).toContain("Roll Back Game");
  });

  it("does not call onImageGenerationChange when the toggle is not dirty", async () => {
    const onImages = vi.fn();
    const onDismiss = vi.fn();
    const { stdin } = renderModal(minimalConfig(), undefined, undefined, undefined, onImages, onDismiss);
    stdin.write("\r"); // Enter without any change
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(onImages).not.toHaveBeenCalled();
  });
});
