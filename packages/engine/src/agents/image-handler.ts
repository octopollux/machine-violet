/**
 * Generated-image bytes → disk + relative-path resolution.
 *
 * Called inline from the two function-tool dispatchers
 * (`setup-conversation.ts` for chargen portraits, `game-engine.ts` for
 * gameplay scene snapshots / portraits / player-requested illustrations)
 * once per image the provider returns from `generateImage`. Decodes the
 * base64 payload to raw bytes, picks a filename keyed off the image's
 * intent + scene context, and writes both the binary file and a small
 * JSON sidecar carrying `revisedPrompt` + intent + timestamp for audit.
 *
 * Returns the relative path (under the campaign root) so the caller can
 * thread it into a TUI command, a transcript line, or wherever the
 * downstream rendering or persistence needs it.
 *
 * Failures (write errors, missing writeBinaryFile, malformed base64)
 * throw — the caller decides whether to log and continue or surface as
 * a turn failure. The image-generation success path is meaningful enough
 * that silent loss would be worse than a visible exception.
 */
import { join, relative } from "node:path";
import type { FileIO } from "./scene-manager.js";
import { campaignPaths } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { logEvent } from "../context/engine-log.js";

export interface ImageHandlerScene {
  sceneNumber: number;
  /** Scene slug, e.g. "tavern-meeting". Used in scene-snapshot filenames. */
  slug: string;
}

export interface ImageGeneratedPart {
  id: string;
  base64: string;
  mimeType: string;
  intent: "scene_snapshot" | "player_request" | "character_portrait";
  revisedPrompt?: string;
}

export interface ImageHandlerResult {
  /**
   * Path relative to campaign root, forward-slash normalized. Suitable
   * for use in TUI commands and transcript references — the consumer
   * resolves to absolute by joining with the campaign root.
   */
  relPath: string;
}

export async function handleImageGenerated(
  fileIO: FileIO,
  campaignRoot: string,
  scene: ImageHandlerScene | null,
  part: ImageGeneratedPart,
  now: () => number = Date.now,
): Promise<ImageHandlerResult> {
  if (!fileIO.writeBinaryFile) {
    throw new Error(
      "FileIO.writeBinaryFile is required for image persistence; " +
      "use createBaseFileIO() in production or extend the test mock.",
    );
  }

  const paths = campaignPaths(campaignRoot);
  await fileIO.mkdir(paths.imagesDir);

  const ext = mimeToExt(part.mimeType);
  const timestamp = now();
  const basename = pickBasename(part.intent, scene, timestamp, ext);

  const absImage = paths.image(basename);
  const bytes = decodeBase64(part.base64);
  await fileIO.writeBinaryFile(absImage, bytes);
  // Last hop in the on-disk chain — if image_gen:completed fired but this
  // crumb doesn't appear, persistence (not generation) is at fault.
  logEvent("image_gen:persisted", {
    id: part.id,
    intent: part.intent,
    path: norm(absImage),
    bytes: bytes.length,
  });

  // Sidecar JSON — small audit record alongside the image. Never load-bearing
  // for rendering; purely for debugging ("what was the model actually asking
  // for when it generated this?").
  const sidecar = {
    id: part.id,
    intent: part.intent,
    timestamp,
    mimeType: part.mimeType,
    ...(scene ? { sceneNumber: scene.sceneNumber, sceneSlug: scene.slug } : {}),
    ...(part.revisedPrompt ? { revisedPrompt: part.revisedPrompt } : {}),
  };
  const absSidecar = paths.image(`${basename.replace(/\.[^.]+$/, "")}.json`);
  await fileIO.writeFile(absSidecar, JSON.stringify(sidecar, null, 2));

  return { relPath: norm(relative(campaignRoot, absImage)) };
}

function pickBasename(
  intent: ImageGeneratedPart["intent"],
  scene: ImageHandlerScene | null,
  timestamp: number,
  ext: string,
): string {
  switch (intent) {
    case "scene_snapshot": {
      const n = scene ? String(scene.sceneNumber).padStart(3, "0") : "000";
      const slug = scene?.slug || "untitled";
      return `scene-${n}-${slug}-${timestamp}.${ext}`;
    }
    case "player_request":
      return `request-${timestamp}.${ext}`;
    case "character_portrait":
      // Setup-agent owns the confirmed-portrait path (characters/<slug>-portrait.png).
      // While iterating in the show-and-confirm loop, drafts land here and
      // get cleaned up on accept. Game-engine should never see this intent
      // — log loudly if it does.
      return `portrait-draft-${timestamp}.${ext}`;
  }
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

function decodeBase64(b64: string): Uint8Array {
  // Buffer.from is the most portable path on Node; avoids a dependency
  // on the global `atob` for binary safety (atob produces a string per
  // byte which then needs char-code unrolling).
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Re-export for callers building absolute paths against the same root.
export { join };
