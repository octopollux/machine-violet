import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import { parseOkf } from "./okf.js";

/**
 * Resolve a visual-style variant to a single bare render directive — the
 * one-sentence instruction (e.g. the prestige-film-still line) that gets
 * appended to a `generate_image` prompt.
 *
 * This is the style-name → style-text lookup the setup agent's chargen portrait
 * uses (see setup-conversation's `dispatchGenerateImage`): given a seed's
 * `image_style` stem, it returns just the directive to stamp on the portrait
 * prompt. It deliberately returns ONLY the `# Style` section, NOT the
 * `# Direction` preamble ("When composing prompts…, render the image in this
 * visual style:") — that preamble is meta-instruction for the DM reading the
 * resolved `<Image>` block, and would be noise inside an actual image prompt.
 *
 * **Composites resolve to their DEFAULT look.** A plain style's `# Style` is a
 * single backtick-fenced sentence; a campaign *composite* (`AThroneOfSalt`,
 * `Apocrypha`, …) lists a labeled MENU of backtick-fenced directives — a default
 * plus situational variants (outdoor night, dark crisis, surveillance cam, …).
 * The portrait wants exactly ONE directive, and the campaign's everyday look is
 * the right anchor for a character card, so we return the FIRST backtick-fenced
 * span. Composites are authored Default-first precisely so this picks the
 * default — never the whole menu (labels + every variant + their conflicting
 * "Close with a caption…" clauses), which would fight the portrait sheet's
 * black-background, no-chrome framing.
 *
 * The in-game DM path does NOT use this for content — it gets the full `<Image>`
 * block (Direction + the entire Style menu) injected via
 * `<!--include:Image.<style>-->` in campaign_detail and chooses the variant per
 * the Direction. There, finalize calls this only as a truthiness gate (does the
 * stem resolve at all?). This is the one place that needs a style sentence in
 * isolation.
 *
 * Returns `null` for an unknown/malformed style so callers can fall back.
 */
export function resolveImageStyleLine(styleName: string): string | null {
  // Style names are PascalCase file stems (Image, NoirCinema, CinematicFilm).
  // Reject anything else outright — this value can originate from a seed file,
  // so it doubles as path-traversal defense before it touches the filesystem.
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(styleName)) return null;

  const path = join(assetDir("prompts"), "include", "Image", `${styleName}.mvstyle`);
  if (!existsSync(path)) return null;

  const { sections } = parseOkf(readFileSync(path, "utf-8"));
  const style = sections.get("Style");
  if (!style) return null;

  // The `# Style` body holds one or more backtick-fenced render directives: a
  // plain style has exactly one; a composite lists a labeled menu whose FIRST
  // entry is the campaign default. Either way the portrait/gate wants a single
  // directive, so take the first backtick-fenced span — the default — never the
  // whole menu. Style sentences are plain prose with no internal backticks, so a
  // non-greedy run between the first fence pair is unambiguous.
  const firstSpan = style.match(/`([^`]+)`/);
  if (firstSpan) return firstSpan[1].trim() || null;

  // No fences at all — tolerate a bare, fence-less sentence (loose authoring).
  return style.trim() || null;
}
