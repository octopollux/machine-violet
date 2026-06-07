import type { WorldFile, WorldFork, WorldForkOption } from "@machine-violet/shared/types/world.js";
import { slugify } from "../utils/slug.js";

/**
 * Fork handling for seeds (format-spec.md §10).
 *
 * A `.mvworld` can branch into many possible campaigns via named **forks**.
 * Forks are resolved entirely at setup — player-facing ones by the player,
 * agent-decided ones by the setup agent (rolling the dice tool when the seed
 * says "roll or choose"). By the time the DM runs, every fork is collapsed to
 * one option and the unchosen branches are gone; they never reach the DM's
 * context. The selection persists as `config.fork_selections` (forkId → optionId).
 *
 * This module is the single place that (a) unifies the legacy `suboptions`
 * shape into the modern `forks` list, and (b) flattens the selected branches
 * into the campaign's final DM-only `campaign_detail`.
 */

/**
 * Return a seed's forks as a single unified list, folding any legacy
 * player-facing `suboptions` into `forks` (`chooser: "player"`). Modern seeds
 * carry `forks` directly; this keeps older/user-authored files working without
 * a second code path downstream. Fork and option ids are derived from labels/
 * names via `slugify` when a legacy entry is converted; collisions get a numeric
 * suffix so ids stay unique.
 */
export function normalizeForks(world: Pick<WorldFile, "forks" | "suboptions">): WorldFork[] {
  const forks: WorldFork[] = [...(world.forks ?? [])];
  const usedForkIds = new Set(forks.map((f) => f.id));

  for (const sub of world.suboptions ?? []) {
    const forkId = uniqueId(slugify(sub.label), usedForkIds);
    usedForkIds.add(forkId);

    const usedOptionIds = new Set<string>();
    const options: WorldForkOption[] = sub.choices.map((c) => {
      const optionId = uniqueId(slugify(c.name), usedOptionIds);
      usedOptionIds.add(optionId);
      return { id: optionId, name: c.name, description: c.description };
    });

    forks.push({ id: forkId, label: sub.label, chooser: "player", options });
  }

  return forks;
}

/** Append a numeric suffix until `base` (or a fallback) is unused. */
function uniqueId(base: string, used: Set<string>): string {
  let id = base || "fork";
  let n = 2;
  while (used.has(id)) id = `${base || "fork"}-${n++}`;
  return id;
}

/** The option a selection points at within a fork, or undefined if unselected
 *  / the option id is unknown. */
export function selectedOption(
  fork: WorldFork,
  selections: Record<string, string> | undefined,
): WorldForkOption | undefined {
  const optionId = selections?.[fork.id];
  if (!optionId) return undefined;
  return fork.options.find((o) => o.id === optionId);
}

/**
 * Build the campaign's final DM-only detail by flattening the seed's
 * fork-invariant base prose together with the `detail` of each **selected**
 * fork option. Unchosen branches are structurally excluded — this is what
 * keeps the DM from ever seeing the seed's alternate variants.
 *
 * Forks contribute in declaration order, after the base. A fork with no
 * selection, an unknown option id, or a selected option that carries no
 * `detail` contributes nothing.
 */
export function assembleCampaignDetail(
  baseDetail: string | undefined,
  forks: WorldFork[],
  selections: Record<string, string> | undefined,
): string {
  const parts: string[] = [];
  const base = (baseDetail ?? "").trim();
  if (base) parts.push(base);

  for (const fork of forks) {
    const option = selectedOption(fork, selections);
    const detail = option?.detail?.trim();
    if (detail) parts.push(detail);
  }

  return parts.join("\n\n");
}
