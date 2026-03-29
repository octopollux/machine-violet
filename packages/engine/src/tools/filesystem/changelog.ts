/**
 * Append a changelog entry to an entity's changelog.
 * Format: "**Scene NNN**: description"
 */
export function formatChangelogEntry(
  sceneNumber: number,
  description: string,
): string {
  const padded = String(sceneNumber).padStart(3, "0");
  return `**Scene ${padded}**: ${description}`;
}

/**
 * Append a changelog entry to raw markdown content.
 * If no ## Changelog section exists, creates one.
 * Returns the updated markdown.
 */
export function appendChangelog(
  markdown: string,
  entry: string,
): string {
  const changelogHeader = /^##\s+Changelog\s*$/im;
  const match = changelogHeader.exec(markdown);

  if (match) {
    // Find the end of existing changelog entries
    const afterHeader = markdown.slice(match.index + match[0].length);
    const lines = afterHeader.split("\n");
    let lastEntryIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("- ")) {
        lastEntryIdx = i;
      } else if (lines[i].trim() !== "" && i > 0) {
        break;
      }
    }

    // Insert after the last entry
    const before = markdown.slice(0, match.index + match[0].length);
    const entryLines = afterHeader.split("\n");
    entryLines.splice(lastEntryIdx + 1, 0, `- ${entry}`);
    return before + entryLines.join("\n");
  }

  // No changelog section — append one
  const trimmed = markdown.trimEnd();
  return `${trimmed}\n\n## Changelog\n- ${entry}\n`;
}
