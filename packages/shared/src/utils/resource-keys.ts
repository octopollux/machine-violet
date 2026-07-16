/**
 * Canonical coercion for a character's display-resource keys → `string[]`.
 *
 * The same concept carries two shapes in this codebase, by design:
 *
 *   - **Sheet front matter** (`**Display Resources:** HP, Spell Slots`) is a
 *     single comma-separated *string*. All front matter values are strings on
 *     disk; consumers split on `, ` as needed (format-spec.md §6.2).
 *   - **`state/resources.json`** (`displayResources`) is a `string[]`, set by
 *     the `set_display_resources` tool.
 *
 * Nothing enforces the tool's `array` schema at the API layer — both providers
 * send `strict: false`, so a DM that has just written the comma-separated sheet
 * convention can carry that shape straight into the tool call and hand us
 * `"Stress"` where `["Stress"]` was declared. A bare string is still iterable,
 * so it fails *silently and absurdly*: every consumer that does `for (const key
 * of keys)` walks the characters, and the top frame renders `S | t | r | e | s
 * | s` instead of `Stress 0/4`.
 *
 * So: accept both shapes, normalize to the array. Splitting the string form on
 * commas (rather than wrapping it whole) honors the front-matter convention the
 * DM is imitating when it gets this wrong — `"HP, Spell Slots"` means two keys,
 * not one key named "HP, Spell Slots".
 *
 * Lives in @machine-violet/shared because the engine coerces at the tool
 * boundary and the client renders the result; divergence between the two is
 * exactly how the character-splitting bug reaches the screen.
 *
 * Returns a fresh array; never returns holes, blanks, or untrimmed keys.
 * Non-string, non-array input (null, a number, an object) yields `[]` — a
 * character with no resource line is a normal state, so there is nothing to
 * throw about.
 */
export function coerceResourceKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // Elements are declared `string` but arrive unvalidated; a nested array or
    // a number would otherwise poison lookups downstream as `[object Object]`.
    return raw
      .filter((k) => typeof k === "string" || typeof k === "number")
      .map((k) => String(k).trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }
  return [];
}
