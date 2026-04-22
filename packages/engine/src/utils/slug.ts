/**
 * Canonical entity-name → filesystem-slug function for the game engine.
 *
 * Rules:
 *   1. Lowercase
 *   2. Strip a single leading article (the / a / an + whitespace) — so
 *      "The Black Coin" and "Black Coin" produce the same slug.
 *   3. Collapse any run of non-alnum characters to a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *   5. Cap at 50 characters.
 *
 * Idempotent: slugify(slugify(x)) === slugify(x) for any input.
 *
 * This is the function all entity files must be named with. Setup (world
 * builder, character file creation), the DM's scribe tool, and any direct
 * filesystem helper that takes an entity display name must all route through
 * this. Divergent slugification has been the root cause of duplicate entity
 * files (e.g. `Janey Bruce.md` alongside `janey-bruce.md`).
 *
 * Unrelated: `packages/engine/src/content/job-manager.ts` has its own
 * `slugify` for content-pipeline directory names — that pipeline is isolated
 * by design and does not share this function.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
