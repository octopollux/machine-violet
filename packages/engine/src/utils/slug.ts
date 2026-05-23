// Slugify moved to @machine-violet/shared so the client TUI can resolve
// wikilink targets to slugs without divergence. Engine code re-exports here
// to keep historical import paths stable.
export { slugify } from "@machine-violet/shared/utils/slug.js";
