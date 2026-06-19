import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import { parseOkf } from "./okf.js";

/**
 * Resolve a single visual-style variant to its bare `# Style` directive — the
 * one-sentence render instruction (e.g. the prestige-film-still line) that gets
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
 * The in-game DM path does NOT use this — it gets the full `<Image>` block
 * (Direction + Style) injected via `<!--include:Image.<style>-->` in
 * campaign_detail and composes its own prompts. This is the one place that needs
 * the style sentence in isolation.
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

  // The `# Style` body is a single backtick-fenced sentence; strip the fences
  // so the caller appends the raw render instruction, not markdown emphasis.
  return style.replace(/^`+|`+$/g, "").trim() || null;
}
