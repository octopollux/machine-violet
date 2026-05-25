/**
 * Enumerate bundled .theme assets for the theme-styler prompt.
 *
 * Scans the themes asset dir (same source the TUI loads from at runtime)
 * and pulls the @name and @genre_tags metadata out of each file. The
 * theme-styler subagent uses this to populate its prompt with every theme
 * currently shipped, so adding a new .theme file requires no prompt edit.
 *
 * Only the two header fields are extracted — keeping engine independent of
 * the client-ink theme parser, which carries ink/yoga dependencies the
 * engine can't pull in.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assetDir } from "../../utils/paths.js";

export interface ThemeMeta {
  name: string;
  genreTags: string[];
}

let cache: ThemeMeta[] | undefined;

/**
 * Return every bundled theme, sorted by name (deterministic ordering for
 * prompt-cache stability).
 */
export function listAvailableThemes(): ThemeMeta[] {
  if (cache) return cache;

  const dir = assetDir("themes");
  const themes: ThemeMeta[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".theme")) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    const meta = extractMeta(content);
    if (meta) themes.push(meta);
  }

  themes.sort((a, b) => a.name.localeCompare(b.name));
  cache = themes;
  return cache;
}

/**
 * Format the theme list as bullets for inclusion in the styler prompt.
 * Shape: `- <name>: <tag1>, <tag2>, ...`
 */
export function formatThemesForPrompt(themes: ThemeMeta[]): string {
  return themes
    .map((t) => {
      const tags = t.genreTags.length > 0 ? t.genreTags.join(", ") : "general";
      return `- ${t.name}: ${tags}`;
    })
    .join("\n");
}

function extractMeta(content: string): ThemeMeta | null {
  // Strip HTML comments so an @name inside a leading comment block can't be
  // mistaken for the real metadata line.
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "");

  const nameMatch = stripped.match(/^@name:\s*(\S+)/m);
  if (!nameMatch) return null;

  const tagsMatch = stripped.match(/^@genre_tags:\s*(.+)$/m);
  const genreTags = tagsMatch
    ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return { name: nameMatch[1], genreTags };
}

/** Reset the cache. For tests only. */
export function resetThemeListCache(): void {
  cache = undefined;
}
