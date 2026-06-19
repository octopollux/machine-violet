/**
 * Open Knowledge Format (OKF) parser — MV's house format for "we have ten of
 * these" prompt-material collections. Visual styles (`.mvstyle`) are the first;
 * other prompt-material file types migrate onto it over time. An OKF document is
 * YAML-ish frontmatter between `---` fences, then a markdown body of `# Heading`
 * sections.
 *
 * Deliberately minimal — NOT a YAML library. Frontmatter values are flat scalars
 * or flow arrays (`[a, b, c]`); surrounding quotes are stripped. This covers
 * every OKF file we have. If a future file genuinely needs nested/multiline/
 * block-scalar frontmatter, swap a real YAML parser in HERE — every consumer
 * goes through this one function, so the upgrade is one place.
 *
 * Section WHITELISTING — deciding which `# Heading`s are public vs
 * authoring-only — is the CONSUMER's job, not the parser's. (E.g. the visual
 * style loader emits only `# Direction` + `# Style` and drops `# Notes` /
 * `# Example`.) The parser just returns everything it found, in file order.
 */
export interface OkfDocument {
  /** Frontmatter key → value. Flow arrays become `string[]`; scalars are `string`. */
  frontmatter: Record<string, string | string[]>;
  /** `# Heading` section bodies, keyed by trimmed heading text, in file order. */
  sections: Map<string, string>;
}

export function parseOkf(content: string): OkfDocument {
  const normalized = content.replace(/\r\n/g, "\n");
  const frontmatter: Record<string, string | string[]> = {};
  let body = normalized;

  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (fm) {
    body = normalized.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const raw = m[2].trim();
      frontmatter[m[1]] =
        raw.startsWith("[") && raw.endsWith("]")
          ? raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
          : raw.replace(/^["']|["']$/g, "");
    }
  }

  // Split on top-level `# Heading` lines (single hash). `## ` and deeper don't match.
  const sections = new Map<string, string>();
  const headings = [...body.matchAll(/^# (.+)$/gm)];
  for (let i = 0; i < headings.length; i++) {
    const start = (headings[i].index ?? 0) + headings[i][0].length;
    const end = i + 1 < headings.length ? (headings[i + 1].index ?? body.length) : body.length;
    sections.set(headings[i][1].trim(), body.slice(start, end).trim());
  }

  return { frontmatter, sections };
}
