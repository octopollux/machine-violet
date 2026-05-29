import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";

/**
 * Marker line emitted for `kind: "image"` NarrativeLines. The intent
 * (scene_snapshot / player_request / character_portrait) is encoded in
 * the marker so the roundtrip preserves it.
 *
 * Paths are stored campaign-root-relative whenever a `campaignRoot` is
 * supplied to {@link narrativeLinesToMarkdown} — so a campaign moved
 * between machines keeps its scrollback images intact, as long as the
 * relative path under the new root still resolves. Absolute paths in
 * legacy display-logs are tolerated by the reader as a backward-compat
 * fall-through: any path matching `/^([A-Za-z]:[\\/]|\/)/` is treated
 * as already absolute and passed through unchanged.
 */
const IMAGE_INTENTS = new Set(["scene_snapshot", "player_request", "character_portrait"] as const);
const IMAGE_LINE_RE = /^\[image:(scene_snapshot|player_request|character_portrait)\] (.+)$/;
const ABSOLUTE_PATH_RE = /^([A-Za-z]:[\\/]|\/)/;

/** True if the path looks absolute (Unix `/...` or Windows `X:\...` / `X:/...`). */
function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH_RE.test(path);
}

/** Strip a trailing path separator (either `/` or `\`) for normalization. */
function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/**
 * Make an absolute image path relative to the campaign root, using forward
 * slashes for portability. If the path doesn't sit under the root (e.g.
 * the user pointed at an image somewhere else on disk), return it as-is —
 * better to keep a working absolute reference than to invent a broken
 * relative one.
 */
function relativizeImagePath(absPath: string, campaignRoot: string): string {
  const normPath = absPath.replace(/\\/g, "/");
  const normRoot = stripTrailingSep(campaignRoot).replace(/\\/g, "/");
  const prefix = normRoot + "/";
  // Case-insensitive on Windows; pragmatic to apply everywhere — image
  // paths in this codebase are ASCII and case-folding is harmless.
  if (normPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPath.slice(prefix.length);
  }
  return absPath;
}

/**
 * Join a campaign-root-relative path back to absolute. Idempotent for
 * paths that are already absolute (legacy display-logs).
 */
function absolutizeImagePath(maybeRelative: string, campaignRoot: string): string {
  if (isAbsolutePath(maybeRelative)) return maybeRelative;
  return stripTrailingSep(campaignRoot) + "/" + maybeRelative;
}

/**
 * Convert NarrativeLines to markdown for appending to display-log.md.
 * Dev lines are excluded — they're ephemeral debug info.
 *
 * When `campaignRoot` is supplied, image-line paths under that root are
 * stored relative — improves portability when the campaign dir moves.
 */
export function narrativeLinesToMarkdown(lines: NarrativeLine[], campaignRoot?: string): string {
  const parts: string[] = [];
  for (const line of lines) {
    switch (line.kind) {
      case "dm":
        parts.push(line.text);
        break;
      case "player":
        parts.push(`> ${line.text}`);
        break;
      case "system":
        parts.push(`[system] ${line.text}`);
        break;
      case "separator":
        parts.push("---");
        break;
      case "image": {
        const stored = campaignRoot ? relativizeImagePath(line.text, campaignRoot) : line.text;
        parts.push(`[image:${line.intent}] ${stored}`);
        break;
      }
      case "spacer":
      case "dev":
        // Ephemeral — not logged
        break;
    }
  }
  return parts.join("\n") + "\n";
}

/**
 * Parse markdown lines from display-log.md back to NarrativeLines.
 *
 * When `campaignRoot` is supplied, relative image-line paths are
 * resolved against it. Absolute paths (legacy display-logs) are
 * preserved unchanged.
 */
export function markdownToNarrativeLines(lines: string[], campaignRoot?: string): NarrativeLine[] {
  const result: NarrativeLine[] = [];
  for (const line of lines) {
    const imgMatch = IMAGE_LINE_RE.exec(line);
    if (imgMatch && IMAGE_INTENTS.has(imgMatch[1] as never)) {
      const stored = imgMatch[2];
      const resolved = campaignRoot ? absolutizeImagePath(stored, campaignRoot) : stored;
      result.push({
        kind: "image",
        text: resolved,
        intent: imgMatch[1] as "scene_snapshot" | "player_request" | "character_portrait",
      });
    } else if (line.startsWith("> ")) {
      result.push({ kind: "player", text: line.slice(2) });
    } else if (line.startsWith("[system] ")) {
      result.push({ kind: "system", text: line.slice(9) });
    } else if (line === "---") {
      result.push({ kind: "separator", text: "---" });
    } else {
      result.push({ kind: "dm", text: line });
    }
  }
  return result;
}

/** Return the last `maxLines` lines from a string, trimming trailing blanks. */
export function tailLines(content: string, maxLines: number): string[] {
  const lines = content.split("\n");
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.slice(-maxLines);
}

// ---------------------------------------------------------------------------
// Resume broadcast
// ---------------------------------------------------------------------------

/**
 * Events emitted while replaying a display-log to the client during
 * session resume. Mirrors the wire shapes the live engine emits:
 *  - `narrative:chunk` for consecutive same-kind text (dm/player/system/dev)
 *  - `activity:update` carrying a display_image command for image lines
 */
export type DisplayLogReplayEvent =
  | {
      type: "narrative:chunk";
      data: { text: string; kind: "dm" | "player" | "system" | "dev" };
    }
  | {
      type: "activity:update";
      data: {
        engineState: "tui:display_image";
        type: "display_image";
        filename: string;
        intent: "scene_snapshot" | "player_request" | "character_portrait";
      };
    };

/**
 * Replay a parsed display-log into a sequence of broadcast events for
 * the resume code path. Pure: no I/O, no side effects, deterministic
 * given the input. Extracted from session-manager so the loop is unit
 * testable.
 *
 * Rules:
 *  - Consecutive same-kind dm/player/system/dev lines coalesce into one
 *    `narrative:chunk` joined with newlines.
 *  - Separator lines become DM lines with text `"---"` (the formatting
 *    pipeline renders them as horizontal rules on the client).
 *  - Image lines flush any in-flight chunk first, then emit one
 *    `activity:update` carrying display_image. This matches the live
 *    broadcast order: the client's event-handler appends the image
 *    NarrativeLine at exactly that ordinal position in scrollback.
 *  - Spacer lines are skipped (presentation-only).
 */
export function* iterDisplayLogReplay(
  narrativeLines: NarrativeLine[],
): Generator<DisplayLogReplayEvent> {
  let currentKind: "dm" | "player" | "system" | "dev" | "" = "";
  let currentText = "";
  const flush = (): DisplayLogReplayEvent | null => {
    if (!currentText || !currentKind) return null;
    const ev: DisplayLogReplayEvent = {
      type: "narrative:chunk",
      data: { text: currentText, kind: currentKind },
    };
    currentText = "";
    return ev;
  };

  for (const line of narrativeLines) {
    if (line.kind === "image") {
      const pending = flush();
      if (pending) yield pending;
      currentKind = "";
      yield {
        type: "activity:update",
        data: {
          engineState: "tui:display_image",
          type: "display_image",
          filename: line.text,
          intent: line.intent,
        },
      };
      continue;
    }

    let kind: "dm" | "player" | "system" | "dev" | undefined;
    let text = line.text;
    if (line.kind === "separator") {
      kind = "dm";
      text = "---";
    } else if (line.kind === "dm" || line.kind === "player" || line.kind === "system" || line.kind === "dev") {
      kind = line.kind;
    } else {
      // spacer or anything else — skip
      continue;
    }

    if (kind !== currentKind) {
      const pending = flush();
      if (pending) yield pending;
    }
    currentKind = kind;
    currentText += (currentText ? "\n" : "") + text;
  }

  const trailing = flush();
  if (trailing) yield trailing;
}
