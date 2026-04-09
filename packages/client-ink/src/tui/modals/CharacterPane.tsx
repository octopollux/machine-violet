/**
 * CharacterPane — right-side overlay showing active character stats & inventory.
 *
 * Appears inside the narrative pane while Tab is toggled.
 * Lazy-fetches the character sheet on first open and caches it until
 * the active player changes. Cache is owned by the caller via
 * cachedContent/onContentLoaded props so it persists across toggles.
 */
import React, { useEffect, useRef, useMemo, forwardRef } from "react";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import type { ApiClient } from "../../api-client.js";
import { markdownToTags, parseFormatting } from "../formatting.js";
import { OverlayPane } from "./OverlayPane.js";
import type { OverlayPaneHandle } from "./OverlayPane.js";

export type CharacterPaneHandle = OverlayPaneHandle;

/** Default pane width in columns. */
export const CHARACTER_PANE_WIDTH = 35;

/**
 * Extract named sections from a character sheet markdown string.
 * Returns lines between `## <heading>` and the next `##` or EOF.
 * The heading line itself is included (will render bold via markdownToTags).
 */
export function extractSections(
  markdown: string,
  headings: string[],
): string[] {
  const lines = markdown.split("\n");
  const lowerHeadings = new Set(headings.map((h) => h.toLowerCase()));
  const result: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      const name = headingMatch[1].trim().toLowerCase();
      if (lowerHeadings.has(name)) {
        if (result.length > 0) result.push(""); // blank line between sections
        capturing = true;
        result.push(line);
        continue;
      } else {
        capturing = false;
        continue;
      }
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result;
}

/** Strip wikilink brackets: [[Name]] → Name */
function stripWikilinks(line: string): string {
  return line.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/**
 * Convert markdown table blocks into formatted key–value lines.
 *
 * A table block is a contiguous run of lines starting with `|`.
 * Two-column tables become `**key:** value` lines (compact for narrow panes).
 * Wider tables are rendered as aligned columns separated by `  `.
 * Separator rows (`|---|---|`) are dropped.
 */
export function renderMarkdownTables(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trimStart().startsWith("|")) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Collect contiguous table rows
    const tableLines: string[] = [];
    while (i < lines.length && lines[i].trimStart().startsWith("|")) {
      tableLines.push(lines[i]);
      i++;
    }

    // Parse cells: split on | and trim, skip separator rows
    const rows: string[][] = [];
    for (const tl of tableLines) {
      if (/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(tl)) continue; // separator row
      const trimmed = tl.trim();
      const cells = trimmed.split("|").map((c) => c.trim());
      // Strip outer empty entries from leading/trailing pipes
      if (trimmed.startsWith("|") && cells[0] === "") cells.shift();
      if (trimmed.endsWith("|") && cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length === 0) continue;

    const header = rows[0];
    const dataRows = rows.slice(1);

    if (header.length === 2 && dataRows.length > 0) {
      // Two-column table → bold key: value
      for (const row of dataRows) {
        result.push(`**${row[0] ?? ""}:** ${row[1] ?? ""}`);
      }
    } else {
      // General table — compute column widths and render aligned
      const colCount = Math.max(...rows.map((r) => r.length));
      const widths: number[] = Array.from({ length: colCount }, () => 0);
      for (const row of rows) {
        for (let c = 0; c < row.length; c++) {
          widths[c] = Math.max(widths[c], row[c].length);
        }
      }

      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r];
        const formatted = cells
          .map((cell, c) => {
            const pad = " ".repeat(Math.max(widths[c] - cell.length, 0));
            return r === 0 ? `**${cell}**${pad}` : `${cell}${pad}`;
          })
          .join("  ");
        result.push(formatted);
      }
    }
  }

  return result;
}

interface CharacterPaneProps {
  theme: ResolvedTheme;
  /** Character name (display name, not slug). */
  characterName: string;
  /** API client for fetching character sheet. */
  apiClient: ApiClient;
  /** Width of the narrative area in columns. */
  narrativeWidth: number;
  /** Height of the narrative area in rows. */
  narrativeHeight: number;
  /** Vertical offset (e.g. top frame height). */
  topOffset?: number;
  /** Cached sheet content (owned by caller for persistence across toggles). */
  cachedContent?: string | null;
  /** Called when sheet content is fetched. Caller should store it for cachedContent. */
  onContentLoaded?: (content: string | null) => void;
}

export const CharacterPane = forwardRef<CharacterPaneHandle, CharacterPaneProps>(
  function CharacterPane({
    theme,
    characterName,
    apiClient,
    narrativeWidth,
    narrativeHeight,
    topOffset = 0,
    cachedContent,
    onContentLoaded,
  }, ref) {
  const lastFetchedName = useRef<string>("");

  // Lazy-fetch character sheet; re-fetch when character changes.
  // Stale flag prevents race conditions from overlapping requests.
  useEffect(() => {
    if (characterName === lastFetchedName.current && cachedContent != null) return;
    lastFetchedName.current = characterName;

    let isStale = false;
    apiClient.getCharacterSheet(characterName)
      .then(({ content }: { content: string }) => {
        if (!isStale) onContentLoaded?.(content);
      })
      .catch(() => {
        if (!isStale) onContentLoaded?.("");
      });

    return () => { isStale = true; };
  }, [characterName, apiClient, cachedContent, onContentLoaded]);

  const sheetContent = cachedContent ?? null;

  // Parse Stats + Inventory sections
  const styledLines = useMemo((): FormattingNode[][] | undefined => {
    if (!sheetContent) return undefined;
    const sectionLines = extractSections(sheetContent, ["Stats", "Inventory"]);
    if (sectionLines.length === 0) return undefined;
    const processed = renderMarkdownTables(sectionLines);
    return processed.map(
      (line) => parseFormatting(markdownToTags(stripWikilinks(line))),
    );
  }, [sheetContent]);

  // Show a placeholder while loading, an error message on failure, or nothing
  const placeholderLines = sheetContent == null
    ? ["", "  Loading..."]
    : sheetContent === ""
      ? ["", "  Could not load", "  character sheet."]
      : !styledLines
        ? ["", "  No stats or", "  inventory found."]
        : undefined;

  return (
    <OverlayPane
      ref={ref}
      theme={theme}
      narrativeWidth={narrativeWidth}
      narrativeHeight={narrativeHeight}
      paneWidth={CHARACTER_PANE_WIDTH}
      title={characterName}
      lines={placeholderLines}
      styledLines={placeholderLines ? undefined : styledLines}
      topOffset={topOffset}
    />
  );
});
