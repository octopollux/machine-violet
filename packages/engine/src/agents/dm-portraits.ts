/**
 * Load player-character portraits into a synthetic prefix message the DM
 * sees on every turn.
 *
 * The message is prepended to the conversation as a non-ephemeral first
 * user message carrying `image_input` ContentParts — one per PC that has
 * a portrait file on disk. Marked non-ephemeral so it lives inside the
 * BP4 cached prefix; portraits cost tokens once per cache write rather
 * than every turn (low-detail flag flattens cost further on the OpenAI
 * Responses API path — ~85 input tokens per image regardless of size).
 *
 * Tolerates missing portraits silently. A campaign whose player initially
 * declined image generation has no portrait files; this returns null and
 * the DM context proceeds text-only. Later flipping image gen to "on"
 * without regenerating portraits still works — the DM authors character
 * appearance from the textual PC summaries the way it always did. See
 * the `image-gen-portraits-must-be-robust` memory.
 */
import type { NormalizedMessage, ContentPart, GenerateImageRequest } from "../providers/types.js";
import type { FileIO } from "./scene-manager.js";
import { campaignPaths } from "../tools/filesystem/index.js";

export interface PortraitablePlayer {
  /** Display character name — used as the slug source for the portrait path. */
  character: string;
}

export async function loadDmPortraitMessage(
  players: readonly PortraitablePlayer[],
  fileIO: FileIO,
  campaignRoot: string,
): Promise<NormalizedMessage | null> {
  if (!fileIO.readBinaryFile) return null;

  const parts: ContentPart[] = [];
  const paths = campaignPaths(campaignRoot);

  for (const player of players) {
    const portraitPath = paths.characterPortrait(player.character);
    if (!(await fileIO.exists(portraitPath))) continue;
    try {
      const bytes = await fileIO.readBinaryFile(portraitPath);
      parts.push({
        type: "image_input",
        base64: Buffer.from(bytes).toString("base64"),
        mimeType: "image/png",
        lowDetail: true,
        label: player.character,
      });
    } catch {
      // Read failure (permissions, corruption) — skip this PC's portrait
      // rather than failing the turn. The DM can author appearance from
      // the textual PC summary.
    }
  }

  if (parts.length === 0) return null;

  return {
    role: "user",
    ephemeral: false,
    content: [
      { type: "text", text: "Party portraits (visual reference for the player characters):" },
      ...parts,
    ],
  };
}

/**
 * Resolve DM-named characters to image-to-image reference portraits for a
 * single `generate_image` call.
 *
 * The DM opts in per render by listing the characters whose established look
 * the image should match (e.g. a close-up of one specific PC). Each name maps
 * to its on-disk portrait — `<campaign>/characters/<slug>-portrait.png`, the
 * very file {@link loadDmPortraitMessage} injects — via the same `slugify`
 * path. Names with no portrait on disk (an NPC, a PC whose player declined
 * image gen, a typo) are skipped silently, so a partial match still conditions
 * on whoever IS found and a total miss renders text-only rather than erroring.
 *
 * Returns the provider `referenceImages` shape. An empty array means "no usable
 * references" — the caller should omit the field entirely so a plain text-to-
 * image render happens. Deduplicates by resolved path so naming the same
 * character twice doesn't double-send multi-MB bytes.
 */
export async function loadCharacterReferences(
  names: readonly string[],
  fileIO: FileIO,
  campaignRoot: string,
): Promise<NonNullable<GenerateImageRequest["referenceImages"]>> {
  if (!fileIO.readBinaryFile) return [];

  const paths = campaignPaths(campaignRoot);
  const out: NonNullable<GenerateImageRequest["referenceImages"]> = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const portraitPath = paths.characterPortrait(name);
    if (seen.has(portraitPath)) continue;
    seen.add(portraitPath);
    if (!(await fileIO.exists(portraitPath))) continue;
    try {
      const bytes = await fileIO.readBinaryFile(portraitPath);
      out.push({
        base64: Buffer.from(bytes).toString("base64"),
        mimeType: "image/png",
        label: name,
      });
    } catch {
      // Read failure (permissions, corruption) — skip; a missing reference
      // just means this character is rendered from the description alone.
    }
  }

  return out;
}
