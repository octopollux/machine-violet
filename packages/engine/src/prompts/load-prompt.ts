import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import { applyModelConditionals } from "./apply-model-conditionals.js";

const cache = new Map<string, string>();

function cacheKey(name: string, modelId: string | undefined): string {
  return `${name}\0${modelId ?? ""}`;
}

/**
 * Strip prompt comments before sending to the API.
 * - `%% ...` lines are single-line comments (Obsidian-style)
 * - `<!-- ... -->` are block comments (standard HTML/markdown)
 * Collapses runs of 3+ blank lines left behind by stripping.
 */
export function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "") // block comments
    .replace(/^%%[^\n]*\n?/gm, "") // line comments
    .replace(/\n{3,}/g, "\n\n"); // collapse blank runs
}

/**
 * Load a prompt .md file from the prompts directory.
 * Reads synchronously on first call, caches thereafter (keyed by name + modelId).
 *
 * Pipeline: read → CRLF normalize → apply model conditionals → strip comments.
 * The conditional preprocessor runs before comment stripping because conditional
 * markers are HTML-comment-shaped (`<!--if:...-->`).
 *
 * @param name - Prompt filename without .md extension (e.g. "dm-identity")
 * @param modelId - Active model ID, used by `<!--if:PREFIX-->` conditionals.
 *                  Omit for callers that don't have model context; conditionals
 *                  will resolve to their else branches.
 */
export function loadPrompt(name: string, modelId?: string): string {
  const key = cacheKey(name, modelId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const dir = assetDir("prompts");
  const filePath = join(dir, `${name}.md`);
  const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const content = stripComments(applyModelConditionals(raw, modelId));
  cache.set(key, content);
  return content;
}

/**
 * Load a prompt and interpolate {{placeholders}} with provided values.
 * For dynamic prompts like ai-player that need runtime substitution.
 *
 * @param name - Prompt filename without .md extension
 * @param vars - Key-value map of placeholder replacements
 * @param modelId - Active model ID for conditional inclusion (see loadPrompt).
 */
export function loadTemplate(
  name: string,
  vars: Record<string, string>,
  modelId?: string,
): string {
  const raw = loadPrompt(name, modelId);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** Clear the prompt cache. For testing only. */
export function resetPromptCache(): void {
  cache.clear();
}

/** Number of cached entries. For testing only — lets tests prove cache keying without mocking `readFileSync`. */
export function _cacheSize(): number {
  return cache.size;
}
