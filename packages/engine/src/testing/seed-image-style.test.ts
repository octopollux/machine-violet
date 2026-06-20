/**
 * End-to-end guard for the per-seed visual-style wiring: a bundled seed's
 * `image_style` must travel all the way into the DM's system prompt and override
 * the campaign-wide default.
 *
 * This is the composition the unit tests cover only in pieces:
 *   - finalize appends `<!--include:Image.<style>-->` to campaign_detail
 *     (setup-conversation.test.ts, with fixture worlds);
 *   - processIncludes resolves the directory-backed Image include
 *     (process-includes.test.ts);
 *   - applyLayeredOverrides keeps the last colliding <Image> block
 *     (dm-prompt.test.ts).
 * Here we run them together against EVERY real bundled seed + the real DM prefix
 * builder, so a typo'd seed style, a broken override, or a default regression is
 * caught. Robust to re-grading: it reads each seed's current `image_style` rather
 * than pinning specific seed→style pairs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { loadAllWorlds } from "../config/world-loader.js";
import { normalizeForks, assembleCampaignDetail } from "../config/world-forks.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";
import { resolveImageStyleLine } from "../prompts/image-style.js";
import { parseOkf } from "../prompts/okf.js";
import { assetDir } from "../utils/paths.js";
import { buildDMPrefix } from "../agents/dm-prompt.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import { loadModelConfig } from "../config/models.js";

beforeEach(() => {
  resetPromptCache();
  loadModelConfig({ reset: true });
});

/** The placeholder default wired into dm-directives.md + the portrait fallback. */
const DEFAULT_STYLE = "CinematicFilm";

/**
 * A style's FULL `# Style` body (every variant), not just the first span
 * {@link resolveImageStyleLine} returns. Used to tell a composite that
 * legitimately embeds the CinematicFilm look as one of its variants (so that
 * line is *expected* inside the seed's own block) apart from a leaked default.
 */
function fullStyleBody(styleName: string): string {
  const path = join(assetDir("prompts"), "include", "Image", `${styleName}.mvstyle`);
  return parseOkf(readFileSync(path, "utf-8")).sections.get("Style") ?? "";
}

function baseConfig(campaignDetail?: string): CampaignConfig {
  return {
    name: "Test",
    system: null,
    dm_personality: { name: "grim", prompt_fragment: "You are terse." },
    players: [{ name: "Alice", character: "Aldric", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: { retention_exchanges: 5, max_conversation_tokens: 4000, tool_result_stub_after: 200 },
    recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
    choices: { campaign_default: "never", player_overrides: {} },
    ...(campaignDetail ? { campaign_detail: campaignDetail } : {}),
  } as CampaignConfig;
}

/**
 * Reproduce handleFinalize's campaign_detail composition for a seed with no
 * forks selected and no agent-appended detail — the in-game half of the wiring.
 */
function seedCampaignDetail(world: WorldFile): string | null {
  const assembled = assembleCampaignDetail(world.detail, normalizeForks(world), undefined);
  const raw = world.image_style?.trim() ?? "";
  const styleInclude = raw && resolveImageStyleLine(raw) ? `<!--include:Image.${raw}-->` : null;
  return [assembled, styleInclude].filter(Boolean).join("\n\n") || null;
}

const dmText = (config: CampaignConfig): string =>
  buildDMPrefix(config, {}).system.map((b) => b.text).join("\n");

describe("seed image_style reaches the DM prefix end-to-end", () => {
  const styled = loadAllWorlds().filter((w) => w.world.image_style);

  it("every bundled seed names a resolvable .mvstyle", () => {
    expect(styled.length).toBeGreaterThan(0);
    for (const { slug, world } of styled) {
      expect(
        resolveImageStyleLine(world.image_style!),
        `seed "${slug}" names image_style "${world.image_style}" which does not resolve to a .mvstyle`,
      ).toBeTruthy();
    }
  });

  it("each seed's style resolves into the DM prefix and overrides the default", () => {
    const defaultLine = resolveImageStyleLine(DEFAULT_STYLE)!;
    for (const { slug, world } of styled) {
      const all = dmText(baseConfig(seedCampaignDetail(world) ?? undefined));
      const styleLine = resolveImageStyleLine(world.image_style!)!;

      // The seed's exact style directive reached the DM.
      expect(all, `seed "${slug}": style line missing from DM prefix`).toContain(styleLine);
      // Exactly one <Image> block survives the override cascade.
      expect(
        (all.match(/<Image>/g) ?? []).length,
        `seed "${slug}": expected exactly one <Image> block`,
      ).toBe(1);
      // The default is gone unless the seed deliberately picked it — or its
      // composite legitimately embeds CinematicFilm as one of its looks (e.g.
      // graveyard-shift, whose DEFAULT *is* the cinematic line). In that case the
      // line is expected inside the seed's single <Image> block, not a leak; the
      // count===1 check above already rules out a second, leaked default block.
      const embedsDefault = fullStyleBody(world.image_style!).includes(defaultLine);
      if (world.image_style !== DEFAULT_STYLE && !embedsDefault) {
        expect(all, `seed "${slug}": default style leaked despite a seed override`).not.toContain(defaultLine);
      }
    }
  });

  it("a seedless / fully-custom campaign falls back to the CinematicFilm default", () => {
    const all = dmText(baseConfig());
    expect(all).toContain(resolveImageStyleLine(DEFAULT_STYLE)!);
    expect((all.match(/<Image>/g) ?? []).length).toBe(1);
  });
});
