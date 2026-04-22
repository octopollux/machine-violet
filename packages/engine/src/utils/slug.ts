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
 *   6. Inputs that reduce to the empty string (whitespace-only, punctuation-
 *      only, pure non-ASCII) fall back to `entity-{hash}` with a short
 *      deterministic hash of the original input. Never returns "" — that
 *      would produce hidden `.md` files and collisions.
 *
 * Idempotent: slugify(slugify(x)) === slugify(x) for any input that already
 * produces a non-empty ASCII slug. The empty-input fallback is deterministic
 * per input (same input → same `entity-{hash}`), but slugify of that
 * fallback just returns it unchanged (it's already a valid slug).
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
  const slug = name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  if (slug) return slug;
  // Empty result: the input had no ASCII alnum after lowercasing.
  // Emit a deterministic fallback so the caller gets a valid, non-hidden
  // filename. The hash is short (8 hex) and keyed on the raw input so
  // distinct weird inputs don't collide onto the same file.
  return `entity-${shortHash(name)}`;
}

function shortHash(input: string): string {
  // Simple djb2-style hash, truncated. Not cryptographic — just needs to
  // spread distinct inputs across distinct slugs with high probability.
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
