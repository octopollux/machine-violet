import type { EntityFrontMatter } from "@machine-violet/shared/types/entities.js";

/**
 * Parse front matter from an entity markdown file.
 * Front matter is a series of **Key:** Value lines at the top of the body,
 * after the H1 heading. Not YAML — simpler, more readable for the DM.
 */
export function parseFrontMatter(markdown: string): {
  frontMatter: EntityFrontMatter;
  body: string;
  changelog: string[];
} {
  const lines = markdown.split("\n");
  const frontMatter: EntityFrontMatter = {};

  // Skip leading blank lines and the H1 heading
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].startsWith("# ")) {
    frontMatter._title = lines[i].slice(2).trim();
    i++;
  }

  // Skip blank line after heading
  while (i < lines.length && lines[i].trim() === "") i++;

  // Parse **Key:** Value lines
  const fmPattern = /^\*\*([^*]+):\*\*\s*(.*)$/;
  while (i < lines.length) {
    const match = lines[i].match(fmPattern);
    if (match) {
      const key = normalizeKey(match[1].trim());
      const value = match[2].trim();
      frontMatter[key] = value;
      i++;
    } else {
      break;
    }
  }

  // Everything after front matter until ## Changelog is the body
  const bodyStart = i;

  // Find the changelog section
  const changelog: string[] = [];
  let changelogStart = -1;
  for (let j = bodyStart; j < lines.length; j++) {
    if (/^##\s+Changelog\s*$/i.test(lines[j])) {
      changelogStart = j;
      break;
    }
  }

  let body: string;
  if (changelogStart !== -1) {
    body = lines.slice(bodyStart, changelogStart).join("\n").trim();
    // Parse changelog entries (lines starting with -)
    for (let j = changelogStart + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.startsWith("- ")) {
        changelog.push(line.slice(2));
      }
    }
  } else {
    body = lines.slice(bodyStart).join("\n").trim();
  }

  return { frontMatter, body, changelog };
}

/**
 * Serialize an entity file back to markdown.
 */
export function serializeEntity(
  title: string,
  frontMatter: EntityFrontMatter,
  body: string,
  changelog: string[],
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");

  // Write front matter (skip internal keys starting with _)
  for (const [key, value] of Object.entries(frontMatter)) {
    if (key.startsWith("_") || value === undefined || value === null) continue;
    const displayKey = displayKeyName(key);
    const displayValue = Array.isArray(value) ? value.join(", ") : String(value);
    lines.push(`**${displayKey}:** ${displayValue}`);
  }

  if (body) {
    lines.push("");
    lines.push(body);
  }

  if (changelog.length > 0) {
    lines.push("");
    lines.push("## Changelog");
    for (const entry of changelog) {
      lines.push(`- ${entry}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Extract a named ## section from a markdown body.
 * Returns the text between `## heading` and the next `##` or EOF, trimmed.
 */
export function extractSection(body: string, heading: string): string | undefined {
  const pattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(body);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const nextHeading = body.indexOf("\n## ", start);
  const section = (nextHeading === -1 ? body.slice(start) : body.slice(start, nextHeading)).trim();
  return section || undefined;
}

/** Convert display key to storage key: "Display Resources" -> "display_resources" */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, "_");
}

/**
 * Canonical display names for known front matter keys.
 * Used to avoid lossy round-trips (e.g., "HP" → "hp" → "Hp").
 */
const DISPLAY_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  type: "Type",
  player: "Player",
  class: "Class",
  location: "Location",
  color: "Color",
  disposition: "Disposition",
  additional_names: "Additional Names",
  display_resources: "Display Resources",
  theme: "Theme",
  key_color: "Key Color",
  sheet_status: "Sheet Status",
  hp: "HP",
  ac: "AC",
  xp: "XP",
});

/** Convert storage key to display key: "display_resources" -> "Display Resources" */
export function displayKeyName(key: string): string {
  if (key in DISPLAY_NAMES) return DISPLAY_NAMES[key]!;
  // Fallback: algorithmic title-case for unknown keys
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
