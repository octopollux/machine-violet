/**
 * CharacterPane — right-side overlay showing active character stats & inventory.
 *
 * Appears inside the narrative pane while Tab is held / toggled.
 * Lazy-fetches the character sheet on first open and caches it until
 * the active player changes.
 */
import React, { useState, useEffect, useRef, useMemo } from "react";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import type { ApiClient } from "../../api-client.js";
import { markdownToTags, parseFormatting } from "../formatting.js";
import { OverlayPane } from "./OverlayPane.js";

/** Default pane width in columns. */
export const CHARACTER_PANE_WIDTH = 25;

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
}

export function CharacterPane({
  theme,
  characterName,
  apiClient,
  narrativeWidth,
  narrativeHeight,
  topOffset = 0,
}: CharacterPaneProps) {
  const [sheetContent, setSheetContent] = useState<string | null>(null);
  const lastFetchedName = useRef<string>("");

  // Lazy-fetch character sheet; re-fetch when character changes
  useEffect(() => {
    if (characterName === lastFetchedName.current) return;
    lastFetchedName.current = characterName;
    setSheetContent(null);
    apiClient.getCharacterSheet(characterName)
      .then(({ content }: { content: string }) => setSheetContent(content))
      .catch(() => setSheetContent(null));
  }, [characterName, apiClient]);

  // Parse Stats + Inventory sections
  const styledLines = useMemo((): FormattingNode[][] | undefined => {
    if (!sheetContent) return undefined;
    const sectionLines = extractSections(sheetContent, ["Stats", "Inventory"]);
    if (sectionLines.length === 0) return undefined;
    return sectionLines.map(
      (line) => parseFormatting(markdownToTags(stripWikilinks(line))),
    );
  }, [sheetContent]);

  // Show a placeholder while loading or if no data
  const placeholderLines = !sheetContent
    ? ["", "  Loading..."]
    : !styledLines
      ? ["", "  No stats or", "  inventory found."]
      : undefined;

  return (
    <OverlayPane
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
}
