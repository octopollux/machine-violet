import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * Load a prompt .md file from the prompts directory.
 * Reads synchronously on first call, caches thereafter.
 *
 * @param name - Prompt filename without .md extension (e.g. "dm-identity")
 */
export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const dir = import.meta.dirname;
  const filePath = join(dir, `${name}.md`);
  const content = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  cache.set(name, content);
  return content;
}

/**
 * Load a prompt and interpolate {{placeholders}} with provided values.
 * For dynamic prompts like ai-player that need runtime substitution.
 *
 * @param name - Prompt filename without .md extension
 * @param vars - Key-value map of placeholder replacements
 */
export function loadTemplate(name: string, vars: Record<string, string>): string {
  const raw = loadPrompt(name);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/** Clear the prompt cache. For testing only. */
export function resetPromptCache(): void {
  cache.clear();
}
