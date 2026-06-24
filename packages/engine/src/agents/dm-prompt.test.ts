import { describe, it, expect, beforeEach } from "vitest";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { buildUIState, buildActiveState, buildHardStats, buildDMPrefix } from "./dm-prompt.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import { loadModelConfig } from "../config/models.js";

beforeEach(() => {
  resetPromptCache();
  loadModelConfig({ reset: true });
});

describe("buildUIState", () => {
  it("builds UI state with modelines and style", () => {
    const result = buildUIState({
      modelines: { Aldric: "HP 45/50 | Blessed" },
      styleName: "gothic",
      variant: "exploration",
    });

    expect(result).toContain("Modelines (as last set by you):");
    expect(result).toContain("Aldric: HP 45/50 | Blessed");
    expect(result).toContain("UI: style=gothic, variant=exploration");
  });

  it("includes multiple characters", () => {
    const result = buildUIState({
      modelines: {
        Aldric: "HP 45/50 | Blessed",
        Rook: "HP 28/30 | Poisoned",
      },
      styleName: "arcane",
      variant: "combat",
    });

    expect(result).toContain("Aldric: HP 45/50 | Blessed");
    expect(result).toContain("Rook: HP 28/30 | Poisoned");
    expect(result).toContain("UI: style=arcane, variant=combat");
  });

  it("returns style line even with empty modelines", () => {
    const result = buildUIState({
      modelines: {},
      styleName: "gothic",
      variant: "exploration",
    });

    expect(result).toBeDefined();
    expect(result).toBe("UI: style=gothic, variant=exploration");
    expect(result).not.toContain("Modelines");
  });
});

describe("buildActiveState", () => {
  it("includes PCs section", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric", "Rook"],
      pendingAlarms: [],
    });
    expect(result).toContain("PCs:");
    expect(result).toContain("Aldric");
    expect(result).toContain("Rook");
  });

  it("includes pending alarms", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: ["Sunset at bell 18"],
    });
    expect(result).toContain("Pending alarms:");
    expect(result).toContain("Sunset at bell 18");
  });

  it("includes active objectives", () => {
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
      activeObjectives: ["Find the stolen relic"],
    });
    expect(result).toContain("Objectives:");
    expect(result).toContain("Find the stolen relic");
  });

  it("no longer emits hard-stats fields (resources / turn holder)", () => {
    // Hard numeric state moved to buildHardStats; buildActiveState should not
    // accept or emit those fields. Typing enforces the boundary; this test
    // guards against stringly regressions where "Resources:" or "Turn:" creep
    // back in from unrelated code paths.
    const result = buildActiveState({
      pcSummaries: ["Aldric"],
      pendingAlarms: [],
    });
    expect(result).not.toContain("Resources:");
    expect(result).not.toContain("Turn:");
  });
});

describe("buildHardStats", () => {
  it("renders turn holder and combat round", () => {
    const result = buildHardStats({ turnHolder: "Aldric", combatRound: 3 });
    expect(result).toBe("Turn: Aldric (Round 3)");
  });

  it("renders turn holder without combat round", () => {
    const result = buildHardStats({ turnHolder: "Aldric" });
    expect(result).toBe("Turn: Aldric");
  });

  it("renders resource values", () => {
    const result = buildHardStats({
      resourceValues: { Aldric: { HP: "24/30", "Spell Slots": "3/4" } },
    });
    expect(result).toContain("Resources:");
    expect(result).toContain("Aldric: HP=24/30, Spell Slots=3/4");
  });

  it("renders multiple characters' resources", () => {
    const result = buildHardStats({
      resourceValues: {
        Aldric: { HP: "24/30" },
        Rook: { HP: "28/30" },
      },
    });
    expect(result).toContain("Aldric: HP=24/30");
    expect(result).toContain("Rook: HP=28/30");
  });

  it("returns empty string when nothing to show", () => {
    expect(buildHardStats({})).toBe("");
    expect(buildHardStats({ resourceValues: {} })).toBe("");
    expect(buildHardStats({ resourceValues: { Aldric: {} } })).toBe("");
  });

  it("combines turn holder and resources on separate lines", () => {
    const result = buildHardStats({
      turnHolder: "Aldric",
      resourceValues: { Aldric: { HP: "24/30" } },
    });
    expect(result).toBe("Turn: Aldric\nResources:\n  Aldric: HP=24/30");
  });

  it("renders the active system as the first line", () => {
    const result = buildHardStats({
      activeSystem: "FATE Accelerated",
      turnHolder: "Aldric",
      resourceValues: { Aldric: { HP: "24/30" } },
    });
    expect(result).toBe("System: FATE Accelerated\nTurn: Aldric\nResources:\n  Aldric: HP=24/30");
  });

  it("emits the system line even with no turn holder or resources", () => {
    expect(buildHardStats({ activeSystem: "FATE Accelerated" })).toBe("System: FATE Accelerated");
  });

  it("omits the system line entirely when there is no active system", () => {
    expect(buildHardStats({ turnHolder: "Aldric" })).toBe("Turn: Aldric");
    expect(buildHardStats({ activeSystem: undefined })).toBe("");
  });

  it("tags the system line when mechanics run silently", () => {
    expect(buildHardStats({ activeSystem: "FATE Accelerated", mechanicsSilent: true }))
      .toBe("System: FATE Accelerated · running silently");
  });

  it("does not tag the system line when mechanics are player-facing", () => {
    expect(buildHardStats({ activeSystem: "FATE Accelerated", mechanicsSilent: false }))
      .toBe("System: FATE Accelerated");
  });
});

describe("buildDMPrefix cascading entity override", () => {
  // The override stack is five slots, lowest → highest priority: dm-identity →
  // dm-directives → campaign_detail → personality prompt_fragment → personality
  // detail. When a top-level tag collides across slots, the latest (highest)
  // wins. These tests exercise the seed-vs-personality collision (the inline
  // slots most likely to regress); dm-identity / dm-directives define no
  // <NPCS>, so there's no base block to assert against here.
  const baseConfig = (overrides: Partial<CampaignConfig>): CampaignConfig => ({
    name: "Test",
    system: "D&D 5e",
    dm_personality: { name: "grim", prompt_fragment: "You are terse." },
    players: [{ name: "Alice", character: "Aldric", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: { retention_exchanges: 5, max_conversation_tokens: 4000, tool_result_stub_after: 200 },
    recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
    choices: { campaign_default: "never", player_overrides: {} },
    ...overrides,
  } as CampaignConfig);

  it("DM personality's <NPCS> block wins over seed and main DM", () => {
    const config = baseConfig({
      campaign_detail: "<NPCS>\nseed-npcs\n</NPCS>",
      dm_personality: {
        name: "grim",
        prompt_fragment: "You are terse.\n<NPCS>\npersona-npcs\n</NPCS>",
      },
    });
    const { system } = buildDMPrefix(config, {});
    const all = system.map((b) => b.text).join("\n");

    expect(all).toContain("persona-npcs");
    expect(all).not.toContain("seed-npcs");
    // The main DM file (dm-identity / dm-directives) does not currently define
    // <NPCS>, so there's no "main-npcs" to assert against — the seed-vs-personality
    // case is the meaningful collision and the one most likely to regress.
  });

  it("seed's <NPCS> block wins when personality doesn't define one", () => {
    const config = baseConfig({
      campaign_detail: "<NPCS>\nseed-npcs\n</NPCS>",
    });
    const { system } = buildDMPrefix(config, {});
    const all = system.map((b) => b.text).join("\n");
    expect(all).toContain("seed-npcs");
  });

  it("leaves uncolliding tags from each layer alone", () => {
    const config = baseConfig({
      campaign_detail: "<WORLD_LORE>\nseed-only\n</WORLD_LORE>",
      dm_personality: {
        name: "grim",
        prompt_fragment: "You are terse.\n<VOICE>\npersona-only\n</VOICE>",
      },
    });
    const { system } = buildDMPrefix(config, {});
    const all = system.map((b) => b.text).join("\n");
    expect(all).toContain("seed-only");
    expect(all).toContain("persona-only");
  });
});

describe("buildDMPrefix model conditionals", () => {
  // Regression guard for issue #483: the runtime tier-resolved model ID must
  // reach loadPrompt so `<!--if:gpt-->` blocks in dm-directives.md resolve
  // their if-branch when the DM is actually served by an OpenAI provider.
  const mockConfig: CampaignConfig = {
    name: "Test",
    system: "D&D 5e",
    dm_personality: { name: "grim", prompt_fragment: "You are terse." },
    players: [{ name: "Alice", character: "Aldric", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: { retention_exchanges: 5, max_conversation_tokens: 4000, tool_result_stub_after: 200 },
    recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
    choices: { campaign_default: "never", player_overrides: {} },
  } as CampaignConfig;

  // Phrase from dm-directives.md's <!--if:gpt--> block. If the conditional
  // body changes, update this string — the test asserts the conditional
  // plumbing, not the specific wording.
  const GPT_ONLY_PHRASE = `Not X, but Y`;

  it("includes if:gpt block when a gpt-* model ID is threaded through", () => {
    const { system } = buildDMPrefix(mockConfig, {}, "gpt-5.5");
    const allText = system.map((b) => b.text).join("\n");
    expect(allText).toContain(GPT_ONLY_PHRASE);
  });

  it("omits if:gpt block when a claude-* model ID is threaded through", () => {
    const { system } = buildDMPrefix(mockConfig, {}, "claude-opus-4-6");
    const allText = system.map((b) => b.text).join("\n");
    expect(allText).not.toContain(GPT_ONLY_PHRASE);
  });
});
