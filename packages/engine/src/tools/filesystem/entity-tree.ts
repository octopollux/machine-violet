/**
 * Entity tree — thin compatibility shim.
 *
 * The real scan/index lives in `entities/store.ts`. This module exists so
 * legacy call sites (session-manager, scene-manager) keep working with their
 * existing import path while the underlying scan goes through the store.
 *
 * `renderEntityTree` is pure formatting and lives here; everything else
 * delegates.
 */
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { EntityStore, type EntityFileIO } from "../../entities/store.js";

/**
 * Build the entity tree by scanning all entity directories on disk.
 *
 * Thin wrapper around `EntityStore.scanIndex`. Kept for back-compat with
 * existing callers — new code should construct an EntityStore once and reuse
 * it instead of paying the construction cost on every scan.
 */
export async function buildEntityTree(
  campaignRoot: string,
  fileIO: EntityFileIO,
): Promise<EntityTree> {
  return new EntityStore(campaignRoot, fileIO).scanIndex();
}

/**
 * Render the entity tree as a compact string for context injection.
 * One line per entity: path — Name (type) aka Alias1, Alias2
 */
export function renderEntityTree(tree: EntityTree): string | undefined {
  const slugs = Object.keys(tree);
  if (slugs.length === 0) return undefined;

  const lines: string[] = [];
  for (const slug of slugs.sort()) {
    const e = tree[slug];
    const aliasSuffix = e.aliases.length > 0 ? ` aka ${e.aliases.join(", ")}` : "";
    lines.push(`${e.path} — ${e.name} (${e.type})${aliasSuffix}`);
  }
  return lines.join("\n");
}
