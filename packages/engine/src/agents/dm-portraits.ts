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
import type { NormalizedMessage, ContentPart } from "../providers/types.js";
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
