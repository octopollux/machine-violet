/**
 * A wikilink extracted from markdown.
 * Uses standard markdown link syntax: [display text](relative/path.md)
 */
export interface WikiLink {
  display: string;
  target: string;
  line: number; // 1-indexed line number
}

/**
 * Extract all markdown links from a string.
 * Matches [text](path) where path ends in .md or .json
 */
export function extractWikilinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = markdown.split("\n");
  const linkPattern = /\[([^\]]+)\]\(([^)]+\.(?:md|json))\)/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    while ((match = linkPattern.exec(lines[i])) !== null) {
      links.push({
        display: match[1],
        target: match[2],
        line: i + 1,
      });
    }
  }

  return links;
}

/**
 * Get unique link targets from a set of wikilinks.
 */
export function uniqueTargets(links: WikiLink[]): string[] {
  return [...new Set(links.map((l) => l.target))];
}
