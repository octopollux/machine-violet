/**
 * In-place mutations of a .theme source string.
 *
 * Keeps the textarea authoritative: we locate and replace individual
 * `key: value` lines inside the [colors] section instead of re-serializing
 * the whole file. Comments, blank lines, and non-target sections are
 * preserved verbatim.
 */

const SECTION_RE = /^\s*\[[a-z_]+\]\s*$/;

interface SectionRange {
  start: number;
  end: number;
}

function findSection(lines: string[], name: string): SectionRange | null {
  const header = `[${name}]`;
  const startIdx = lines.findIndex((l) => l.trim() === header);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { start: startIdx, end: endIdx };
}

/**
 * Set `key: value` within the [colors] section.
 * Replaces an existing line if present, otherwise inserts before the
 * section's trailing blank lines.
 *
 * If [colors] doesn't exist, returns source unchanged.
 */
export function setColorKey(source: string, key: string, value: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const range = findSection(lines, "colors");
  if (!range) return source;

  const keyRe = new RegExp(`^\\s*${key}\\s*:\\s*.*$`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key}: ${value}`;
      return lines.join("\n");
    }
  }

  // Insert after the last non-blank line within the section
  let insertIdx = range.end;
  for (let i = range.end - 1; i > range.start; i--) {
    if (lines[i].trim() !== "") {
      insertIdx = i + 1;
      break;
    }
  }
  lines.splice(insertIdx, 0, `${key}: ${value}`);
  return lines.join("\n");
}
