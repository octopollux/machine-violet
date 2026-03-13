/**
 * Faceted entity index types.
 *
 * Shared between the content processing pipeline (which builds the index)
 * and the game engine (which queries it via search_content). Only types —
 * no logic, no cross-boundary imports.
 */

/** A single entity's facet data: slug, display name, and all front matter fields. */
export interface EntityFacet {
  slug: string;
  name: string;
  /** Front matter key-value pairs, all stored as strings. */
  fields: Record<string, string>;
}

/** All entities within a single category, plus the union of field keys. */
export interface CategoryFacets {
  category: string;
  /** All unique field keys across entities in this category. */
  fieldKeys: string[];
  entities: EntityFacet[];
}
