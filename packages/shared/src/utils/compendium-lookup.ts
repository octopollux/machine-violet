import {
  COMPENDIUM_CATEGORIES,
  type Compendium,
  type CompendiumCategory,
  type CompendiumEntry,
} from "../types/compendium.js";

export interface CompendiumLookupResult {
  entry: CompendiumEntry;
  category: CompendiumCategory;
}

/**
 * Resolve a slug to an entry by scanning every category in canonical order.
 * Returns null if no entry matches.
 *
 * Used by the TUI to follow `[[Name]]` wikilinks in the compendium detail
 * view — the renderer slugifies link text and asks this function whether
 * the destination exists. A null result means the link is broken (rendered
 * red, Wikipedia-style) and is a no-op on Enter.
 */
export function findCompendiumEntryBySlug(
  compendium: Compendium,
  slug: string,
): CompendiumLookupResult | null {
  for (const category of COMPENDIUM_CATEGORIES) {
    const entries = compendium[category];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.slug === slug) return { entry, category };
    }
  }
  return null;
}

/**
 * Build a Set of every slug present in the compendium. Used to mark broken
 * wikilinks at render time without an O(N*L) double scan.
 */
export function collectCompendiumSlugs(compendium: Compendium): Set<string> {
  const slugs = new Set<string>();
  for (const category of COMPENDIUM_CATEGORIES) {
    const entries = compendium[category];
    if (!entries) continue;
    for (const entry of entries) {
      slugs.add(entry.slug);
    }
  }
  return slugs;
}
