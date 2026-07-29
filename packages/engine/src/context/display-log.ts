import type {
  TranscriptChoicePresentation,
  TranscriptChoiceResolution,
  TranscriptMetadataEvent,
  TranscriptStateCheckpoint,
} from "@machine-violet/shared";
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
const METADATA_PREFIX = "<!--mv-transcript-meta:v1:";
const METADATA_RE = /^<!--mv-transcript-meta:v1:([A-Za-z0-9+/=]+)-->$/;

function encodeMetadata(event: TranscriptMetadataEvent): string {
  return `${METADATA_PREFIX}${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}-->`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
    )
  );
}

function isNestedStringRecord(
  value: unknown,
): value is Record<string, Record<string, string>> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(isStringRecord)
  );
}

function isChoicePresentation(value: unknown): value is TranscriptChoicePresentation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const presentation = value as Partial<TranscriptChoicePresentation>;
  return (
    typeof presentation.id === "string"
    && (presentation.source === "present_choices" || presentation.source === "suggestion_generator")
    && typeof presentation.prompt === "string"
    && Array.isArray(presentation.choices)
    && presentation.choices.every((choice) => typeof choice === "string")
    && (
      presentation.descriptions === undefined
      || (
        Array.isArray(presentation.descriptions)
        && presentation.descriptions.every((description) => typeof description === "string")
      )
    )
  );
}

function isChoiceResolution(value: unknown): value is TranscriptChoiceResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const resolution = value as Partial<TranscriptChoiceResolution>;
  if (
    typeof resolution.presentationId !== "string"
    || typeof resolution.playerId !== "string"
    || typeof resolution.contributionText !== "string"
  ) {
    return false;
  }
  if (resolution.kind === "custom") return true;
  return (
    resolution.kind === "option"
    && Number.isInteger(resolution.optionIndex)
    && (resolution.optionIndex ?? -1) >= 0
  );
}

function isStateCheckpoint(value: unknown): value is TranscriptStateCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<TranscriptStateCheckpoint>;
  return (
    state.version === 1
    && isStringRecord(state.modelines)
    && isStringArrayRecord(state.displayResources)
    && isNestedStringRecord(state.resourceValues)
  );
}

function isTranscriptMetadataEvent(value: unknown): value is TranscriptMetadataEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<TranscriptMetadataEvent>;
  switch (event.type) {
    case "state_checkpoint":
      return isStateCheckpoint(event.state);
    case "choices_presented":
      return isChoicePresentation(event.presentation);
    case "choice_resolved":
      return isChoiceResolution(event.resolution);
    default:
      return false;
  }
}

/**
 * Decode a transcript metadata marker. A malformed marker with our reserved prefix is
 * intentionally swallowed instead of becoming visible DM prose.
 */
function decodeMetadata(line: string): TranscriptMetadataEvent | null | undefined {
  if (!line.startsWith(METADATA_PREFIX)) return undefined;
  const match = METADATA_RE.exec(line);
  if (!match) return null;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as unknown;
    return isTranscriptMetadataEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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
      case "metadata":
        parts.push(encodeMetadata(line.event));
        break;
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
    const metadata = decodeMetadata(line);
    if (metadata !== undefined) {
      if (metadata) {
        result.push({ kind: "metadata", text: "", event: metadata });
      }
      continue;
    }
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
 *  - `transcript:metadata` for invisible state/choice metadata
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
    }
  | {
      type: "transcript:metadata";
      data: TranscriptMetadataEvent;
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
    if (line.kind === "metadata") {
      const pending = flush();
      if (pending) yield pending;
      currentKind = "";
      yield { type: "transcript:metadata", data: line.event };
      continue;
    }

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
