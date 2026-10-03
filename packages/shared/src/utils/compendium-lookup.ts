import {
  COMPENDIUM_CATEGORIES,
  type Compendium,
  type CompendiumEntry,
} from "../types/compendium.js";
import { slugify } from "./slug.js";

export interface CompendiumLookupResult {
  entry: CompendiumEntry;
  category: string;
}

export function compendiumCollections(compendium: Compendium): [string, CompendiumEntry[]][] {
  return compendium.collections !== undefined ? Object.entries(compendium.collections) : COMPENDIUM_CATEGORIES.map((category) => [category, compendium[category] ?? []]);
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
  const matches: CompendiumLookupResult[] = [];
  for (const [category, entries] of compendiumCollections(compendium)) {
    for (const entry of entries) {
      if (entry.uid === slug || entry.slug === slug) return { entry, category };
      if ([entry.name, ...(entry.aliases ?? [])].some((name) => slugify(name) === slug)) matches.push({ entry, category });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build a Set of every slug present in the compendium. Used to mark broken
 * wikilinks at render time without an O(N*L) double scan.
 */
export function collectCompendiumSlugs(compendium: Compendium): Set<string> {
  const slugs = new Set<string>();
  const names = new Set<string>();
  for (const [, entries] of compendiumCollections(compendium)) {
    for (const entry of entries) {
      slugs.add(entry.slug);
      if (entry.uid) slugs.add(entry.uid);
      for (const name of [entry.name, ...(entry.aliases ?? [])]) names.add(slugify(name));
    }
  }
  for (const name of names) if (findCompendiumEntryBySlug(compendium, name)) slugs.add(name);
  return slugs;
}
