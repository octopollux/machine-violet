/**
 * Auto-colorization for character-sheet-like content (full sheet modal,
 * tab-toggled CharacterPane, compendium detail view).
 *
 * Layers theme-aware coloring on top of markdownToTags so structural
 * elements (`## Headings`, `**Key:**` labels, `[[Wikilinks]]`, bare `#hex`)
 * get visual differentiation that tracks the active theme. Authored
 * formatting tags (`<b>`, `<color=#…>`, etc.) pass through unchanged so
 * the Scribe / Compendium-updater can still add in-character emphasis
 * without colliding with the auto-rules.
 *
 * Per CLAUDE.md the underlying entity markdown is the source of truth and
 * must not be mutated by render-time coloring. Wikilinks are pre-translated
 * into a render-only `<wikilink slug=...>` AST tag that preserves the slug
 * for future navigation features (clicking a wikilink to jump to its sheet).
 */

import type { EntityFrontMatter } from "@machine-violet/shared/types/entities.js";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import { slugify } from "@machine-violet/shared/utils/slug.js";
import type { ResolvedTheme } from "./themes/types.js";
import { markdownToTags, parseFormatting } from "./formatting.js";

export interface ColorizeOptions {
  theme: ResolvedTheme;
  /**
   * Which harmony anchor the surrounding frame uses (0 = main theme,
   * 1 = deriveModalTheme-wrapped). Accent/heading hues are pulled from the
   * OTHER anchor so they visually offset the frame.
   */
  frameAnchor: 0 | 1;
  /** Optional entity front matter; `color` / `key_color` / `theme_color` set the entity hue. */
  frontMatter?: EntityFrontMatter | null;
  /**
   * Wikilink rendering.
   *  - "preserve": wrap `[[Name]]` in a `<wikilink slug=...>` tag (display
   *     name only, brackets gone, slug retained for future navigation).
   *  - "strip": render `[[Name]]` as bare `Name`. Use in views that will
   *     never gain navigation (CharacterPane).
   */
  wikilinks: "preserve" | "strip";
}

/**
 * Bare-hex wrapper: `#rrggbb` → `<color=#rrggbb>#rrggbb</color>`.
 * Negative lookbehind for `=` so hex strings already inside a `<color=…>`
 * tag attribute don't get re-wrapped (which would produce `<color=<color=…>…`
 * and unparseable garbage downstream).
 */
function colorizeHexStrings(line: string): string {
  return line.replace(/(?<!=)#([0-9a-fA-F]{6})\b/g, (match) => `<color=${match}>${match}</color>`);
}

/** Parse `**Key:** Value` front matter lines from the top of an entity markdown body. */
export function parseFrontMatterLines(content: string): EntityFrontMatter {
  const fm: EntityFrontMatter = Object.create(null) as EntityFrontMatter;
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].startsWith("# ")) i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const pat = /^\*\*([^*]+):\*\*\s*(.*)$/;
  while (i < lines.length) {
    const m = lines[i].match(pat);
    if (!m) break;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    const raw = m[2].trim();
    fm[key] = raw === "<none>" ? null : raw;
    i++;
  }
  return fm;
}

/** Pick the entity's intrinsic hue: front-matter color → theme key color fallback. */
function pickEntityHue(theme: ResolvedTheme, fm: EntityFrontMatter | null | undefined): string {
  const candidates = [fm?.color, fm?.key_color, fm?.theme_color];
  for (const c of candidates) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) {
      return c.trim();
    }
  }
  return theme.keyColor;
}

interface Hues {
  /** Strong accent for `## headings` — complement-anchor mid-step. */
  heading: string;
  /** Soft accent for `**Key:**` labels — complement-anchor lighter step. */
  keyLabel: string;
  /** Wikilink color — adopts the entity's hue so cross-references read as
   *  "things in this entity's orbit". Falls back to theme key color. */
  wikilink: string;
}

function pickHues(theme: ResolvedTheme, frameAnchor: 0 | 1, entityHue: string): Hues {
  const complement = (frameAnchor === 0 ? 1 : 0) as 0 | 1;
  const arc = theme.harmonySwatch[complement] ?? theme.swatch;
  // Step indices are conservative — most swatches have 7+ steps. Clamp into bounds.
  const pick = (step: number): string => {
    const idx = Math.min(Math.max(step, 0), arc.length - 1);
    return arc[idx]?.hex ?? theme.keyColor;
  };
  return {
    heading: pick(3),
    keyLabel: pick(4),
    wikilink: entityHue,
  };
}

/** Replace `[[Name]]` per `mode`. "preserve" emits a wikilink tag; "strip" just removes brackets. */
function transformWikilinks(line: string, mode: "preserve" | "strip", color?: string): string {
  return line.replace(/\[\[([^\]]+)\]\]/g, (_match, raw: string) => {
    const name = raw.trim();
    if (mode === "strip") return name;
    const slug = slugify(name);
    const inner = color ? `<color=${color}>${name}</color>` : name;
    return `<wikilink slug=${slug}>${inner}</wikilink>`;
  });
}

/**
 * Colorize one source line. Returns the line as a markup string ready for
 * `parseFormatting`. Detects structural patterns (heading, front-matter KV)
 * before falling through to standard markdown→tag conversion, so the
 * colored wrapper sits on the *outside* of any bold the markdown introduces.
 */
function colorizeLine(line: string, hues: Hues, wikilinks: "preserve" | "strip"): string {
  // Heading — wrap whole line in heading color + bold, bypassing markdownToTags
  // (which would just bold it without color).
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const inner = transformWikilinks(headingMatch[2], wikilinks, hues.wikilink);
    return `<color=${hues.heading}><b>${inner}</b></color>`;
  }

  // Front-matter / table KV line: `**Key:** Value` (or `- **Key:** Value` for lists).
  // Color the bold key span; leave the value to run through normal markdown.
  const kvMatch = line.match(/^(\s*(?:-\s+|·\s+)?)\*\*([^*:]+):\*\*\s*(.*)$/);
  if (kvMatch) {
    const [, lead, key, rest] = kvMatch;
    const valuePart = transformWikilinks(rest, wikilinks, hues.wikilink);
    // Run the *value* through markdownToTags so inline `**bold**`/`*italic*`
    // inside front-matter values still render. The key is hand-wrapped here
    // because the markdown converter doesn't know to color it.
    const valueMarkup = markdownToTags(valuePart);
    return `${lead}<color=${hues.keyLabel}><b>${key}:</b></color> ${valueMarkup}`;
  }

  // Default path: wikilinks first (so brackets become tags), then markdownToTags
  // for bold/italic/list bullets.
  const linkedLine = transformWikilinks(line, wikilinks, hues.wikilink);
  return markdownToTags(linkedLine);
}

/**
 * Colorize a body of markdown lines into ready-to-render formatting nodes.
 * The shared entry point used by CharacterSheetModal, CharacterPane, and
 * the CompendiumModal detail view.
 */
export function colorizeSheetLines(
  lines: string[],
  opts: ColorizeOptions,
): FormattingNode[][] {
  const entityHue = pickEntityHue(opts.theme, opts.frontMatter);
  const hues = pickHues(opts.theme, opts.frameAnchor, entityHue);
  return lines.map((line) => {
    const colored = colorizeLine(line, hues, opts.wikilinks);
    const withHex = colorizeHexStrings(colored);
    return parseFormatting(withHex);
  });
}
