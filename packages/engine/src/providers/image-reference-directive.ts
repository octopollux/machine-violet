/**
 * The shared "match the reference for identity, take expression/pose/etc. from
 * the description" directive appended to an image-render prompt when the DM
 * conditions a render on a character's saved portrait (image-to-image).
 *
 * It lives in one place because BOTH image-gen backends append the identical
 * text:
 *   - the codex / `openai-chatgpt` path bakes it into `buildImagePromptText`,
 *     riding ahead of codex's built-in `image_gen` tool;
 *   - the API-key `openai` path appends it to the `images.edit` prompt.
 *
 * The wording is load-bearing. A saved portrait carries exactly one (neutral)
 * facial expression, so a reference-conditioned render would inherit that flat
 * face regardless of the scene's emotion unless the prompt explicitly claims
 * expression for the *description* side. See `docs/image-generation.md`
 * (Reference conditioning).
 */

/** Oxford-comma join: ["a"] → "a"; ["a","b"] → "a and b"; ["a","b","c"] → "a, b, and c". */
export function formatReferenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Build the reference directive for the given character labels, or "" when
 * there are none. The returned string carries a LEADING space so it appends
 * straight onto a prompt: `prompt + buildReferenceDirective(labels)`.
 */
export function buildReferenceDirective(labels: string[]): string {
  if (labels.length === 0) return "";
  return (
    ` The attached reference image${labels.length > 1 ? "s are" : " is"} the established ` +
    `appearance of ${formatReferenceList(labels)} — match ${labels.length > 1 ? "their" : "that character's"} ` +
    `facial features, build, and outfit to the reference, but follow this description for pose, facial expression, setting, and framing (the reference carries only one neutral expression — take the emotion from the description).`
  );
}
