/**
 * Conditional inclusion preprocessor for prompt .md files.
 *
 * Syntax:
 *   <!--if:PREFIX-->
 *   ...included when modelId starts with PREFIX...
 *   <!--else-->
 *   ...included otherwise (optional)...
 *   <!--endif-->
 *
 * Matching is literal `startsWith` on the model ID — `gpt` matches `gpt-5`,
 * `gpt-5.5`, `gpt-4o`; `claude-opus` matches just opus variants.
 *
 * Undefined `modelId` causes every `if` branch to resolve to its else body
 * (or empty). This keeps untouched callers behaving as before.
 *
 * No nesting. The first `<!--endif-->` after an `<!--if:-->` closes the block;
 * `<!--if:-->` inside an if-body is not honored as a nested conditional.
 *
 * Must run BEFORE `stripComments`, since the markers are HTML-comment-shaped
 * and would otherwise be stripped before the preprocessor sees them.
 */

const CONDITIONAL_RE =
  /<!--if:(\S+?)-->([\s\S]*?)(?:<!--else-->([\s\S]*?))?<!--endif-->/g;

export function applyModelConditionals(
  text: string,
  modelId: string | undefined,
): string {
  return text.replace(CONDITIONAL_RE, (_match, prefix: string, ifBody: string, elseBody: string | undefined) => {
    const matches = modelId !== undefined && modelId.startsWith(prefix);
    return matches ? ifBody : (elseBody ?? "");
  });
}
