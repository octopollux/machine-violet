import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import { CenteredModal, computeModalInnerWidth } from "./CenteredModal.js";
import type { CenteredModalHandle } from "./CenteredModal.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { parseFormatting, wrapNodes } from "../formatting.js";
import { colorizeSheetLines } from "../character-colorization.js";
import { collectWikilinks, markWikilinks } from "../wikilink-nav.js";
import { collectCompendiumSlugs, findCompendiumEntryBySlug } from "@machine-violet/shared/utils/compendium-lookup.js";
import type {
  Compendium,
  CompendiumEntry,
  CompendiumCategory,
} from "@machine-violet/shared/types/compendium.js";
import { COMPENDIUM_CATEGORIES } from "@machine-violet/shared/types/compendium.js";

const CATEGORY_LABELS: Record<CompendiumCategory, string> = {
  characters: "Characters",
  places: "Places",
  items: "Items",
  storyline: "Storyline",
  lore: "Lore",
  objectives: "Objectives",
};

const DETAIL_MODAL_OPTS = { minWidth: 30, maxWidth: 999, widthFraction: 0.6 } as const;

interface CompendiumModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  data: Compendium;
  onClose: () => void;
  topOffset?: number;
}

/** A row in the flattened visible tree list. */
type TreeRow =
  | { type: "category"; key: CompendiumCategory; label: string; count: number; expanded: boolean }
  | { type: "entry"; entry: CompendiumEntry; category: CompendiumCategory };

/**
 * Campaign compendium modal — navigable tree of player knowledge.
 *
 * Tree view: ↑↓ navigates rows, Enter expands a category or opens an entry,
 * ESC closes the modal.
 *
 * Detail view: Tab / Shift+Tab cycle through `[[wikilinks]]` (cursored link
 * renders inverse; links whose slug doesn't resolve render red, Wikipedia-
 * style). Enter follows the cursored link, pushing the current entry onto a
 * back-stack. Backspace pops the stack — back to a previous entry, or to the
 * tree when the stack is empty. ESC always closes the modal.
 */
export function CompendiumModal({
  theme,
  width,
  height,
  data,
  onClose,
  topOffset,
}: CompendiumModalProps) {
  const [expanded, setExpanded] = useState<Set<CompendiumCategory>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<CompendiumEntry | null>(null);
  const [, setHistory] = useState<CompendiumEntry[]>([]);
  const [linkIndex, setLinkIndex] = useState(0);
  const modalRef = useRef<CenteredModalHandle>(null);

  // Build the flat list of visible rows
  const rows: TreeRow[] = useMemo(() => {
    const result: TreeRow[] = [];
    for (const cat of COMPENDIUM_CATEGORIES) {
      const entries = data[cat] ?? [];
      const isExpanded = expanded.has(cat);
      result.push({
        type: "category",
        key: cat,
        label: CATEGORY_LABELS[cat],
        count: entries.length,
        expanded: isExpanded,
      });
      if (isExpanded) {
        for (const entry of entries) {
          result.push({ type: "entry", entry, category: cat });
        }
      }
    }
    return result;
  }, [data, expanded]);

  // Clamp cursor when rows change
  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  useEffect(() => {
    if (clampedCursor !== cursor) setCursor(clampedCursor);
  }, [clampedCursor, cursor]);

  const toggleCategory = useCallback((cat: CompendiumCategory) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Slugs present in the compendium — used to flag broken wikilinks. Recomputed
  // when the underlying data changes (e.g. scribe pass added a new entry).
  const knownSlugs = useMemo(() => collectCompendiumSlugs(data), [data]);

  // --- Detail view: pre-wrap styled lines so wikilink row indices are stable. ---
  const detailContent = useMemo(() => {
    if (!detail) return null;
    // Metadata rows as `**Label:** Value` so the colorizer's KV pattern tints
    // labels like front-matter keys. Summary may contain [[wikilinks]].
    const lines: string[] = [];
    lines.push("");
    lines.push(detail.summary || "(No information yet.)");
    lines.push("");
    if (detail.aliases && detail.aliases.length > 0) {
      lines.push(`**Also known as:** ${detail.aliases.join(", ")}`);
    }
    const sceneValue = detail.firstScene === detail.lastScene
      ? `${detail.firstScene}`
      : `${detail.firstScene}-${detail.lastScene}`;
    const sceneLabel = detail.firstScene === detail.lastScene ? "Scene" : "Scenes";
    lines.push(`**${sceneLabel}:** ${sceneValue}`);
    if (detail.related.length > 0) {
      lines.push(`**Related:** ${detail.related.join(", ")}`);
    }

    const innerWidth = computeModalInnerWidth(theme, width, DETAIL_MODAL_OPTS);
    const styled = colorizeSheetLines(lines, { theme, frameAnchor: 1, wikilinks: "preserve" });
    // Pre-wrap at the modal's exact innerWidth so each wikilink lives on a
    // known row index — required for ensureLineVisible to scroll precisely.
    // CenteredModal will re-wrap, but at the same width this is idempotent.
    const wrapped = styled.flatMap((line) => wrapNodes(line, Math.max(1, innerWidth)));
    const brokenSlugs = new Set<string>();
    const allLinks = collectWikilinks(wrapped, new Set());
    for (const link of allLinks) {
      if (!knownSlugs.has(link.slug)) brokenSlugs.add(link.slug);
    }
    const links = collectWikilinks(wrapped, brokenSlugs);
    return { lines, wrapped, links, brokenSlugs };
  }, [detail, knownSlugs, theme, width]);

  // Reset link selection when the displayed entry changes.
  useEffect(() => {
    if (!detail) return;
    setLinkIndex(0);
  }, [detail]);

  // Auto-scroll the cursored link into view whenever it moves.
  useEffect(() => {
    if (!detailContent) return;
    const link = detailContent.links[linkIndex];
    if (!link) return;
    // Defer to next tick so CenteredModal's ScrollView has settled after re-render.
    const timer = setTimeout(() => modalRef.current?.ensureLineVisible(link.rowIndex), 0);
    return () => clearTimeout(timer);
  }, [detailContent, linkIndex]);

  const navigateBack = useCallback(() => {
    setHistory((prev) => {
      const target = prev[prev.length - 1];
      if (target === undefined) {
        setDetail(null);
        return prev;
      }
      setDetail(target);
      return prev.slice(0, -1);
    });
  }, []);

  const followLink = useCallback(
    (slug: string) => {
      const result = findCompendiumEntryBySlug(data, slug);
      if (!result || !detail) return;
      setHistory((prev) => [...prev, detail]);
      setDetail(result.entry);
    },
    [data, detail],
  );

  useInput((_input, key) => {
    if (detail && detailContent) {
      // ESC always closes the whole modal — consistent with tree view.
      if (key.escape) {
        onClose();
        return;
      }
      if (key.backspace || key.delete) {
        navigateBack();
        return;
      }
      const links = detailContent.links;
      if (key.tab && key.shift) {
        if (links.length > 0) setLinkIndex((i) => (i - 1 + links.length) % links.length);
        return;
      }
      if (key.tab) {
        if (links.length > 0) setLinkIndex((i) => (i + 1) % links.length);
        return;
      }
      if (key.return) {
        const link = links[linkIndex];
        if (!link || link.broken) {
          // No live link to follow — fall back to going up one level so Enter
          // still does something useful on link-less entries.
          if (links.length === 0) navigateBack();
          return;
        }
        followLink(link.slug);
        return;
      }
      return;
    }

    // Tree view
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.downArrow) {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }

    if (key.return) {
      const row = rows[clampedCursor];
      if (!row) return;
      if (row.type === "category") {
        toggleCategory(row.key);
      } else {
        setHistory([]);
        setDetail(row.entry);
      }
      return;
    }
  });

  const modalTheme = useMemo(() => deriveModalTheme(theme), [theme]);
  const textColor = themeColor(modalTheme, "sideFrame");
  const accentColor = themeColor(modalTheme, "title");

  // --- Detail view ---
  if (detail && detailContent) {
    const { wrapped, links, brokenSlugs } = detailContent;
    const styledLines = markWikilinks(wrapped, brokenSlugs, links.length > 0 ? linkIndex : -1);
    const linkFooter = links.length > 0
      ? `${linkIndex + 1}/${links.length} links  *Tab*: next  *Enter*: follow  *Bksp*: back  *ESC*: close`
      : "*Bksp*: back  *ESC*: close";

    return (
      <CenteredModal
        ref={modalRef}
        theme={theme}
        width={width}
        height={height}
        title={detail.name}
        styledLines={styledLines}
        footer={linkFooter}
        minWidth={DETAIL_MODAL_OPTS.minWidth}
        maxWidth={DETAIL_MODAL_OPTS.maxWidth}
        widthFraction={DETAIL_MODAL_OPTS.widthFraction}
        topOffset={topOffset}
      />
    );
  }

  // --- Tree view ---
  const isEmpty = COMPENDIUM_CATEGORIES.every((cat) => (data[cat] ?? []).length === 0);

  if (isEmpty) {
    return (
      <CenteredModal
        theme={theme}
        width={width}
        height={height}
        title="Compendium"
        lines={["", "  No entries yet.", "", "  The compendium fills as you", "  explore and discover.", "", "  ESC to close"]}
        minWidth={30}
        maxWidth={999}
        widthFraction={0.6}
        topOffset={topOffset}
      />
    );
  }

  // Build tree lines as styled FormattingNode arrays for cursor highlighting.
  // Using styledLines instead of React children ensures CenteredModal renders
  // each row with full-width opaque padding (preventing background bleed-through).
  const treeStyledLines: FormattingNode[][] = rows.map((row, i) => {
    const selected = i === clampedCursor;
    const color = selected ? accentColor : textColor;
    if (row.type === "category") {
      const arrow = row.expanded ? "▾" : "▸";
      const prefix = selected ? "◆ " : "  ";
      const label = `${prefix}${arrow} ${row.label} (${row.count})`;
      const markup = selected
        ? `<color=${color}><b>${label}</b></color>`
        : `<color=${color}>${label}</color>`;
      return parseFormatting(markup);
    } else {
      const marker = selected ? "◆" : "○";
      const label = `    ${marker} ${row.entry.name}`;
      const markup = selected
        ? `<color=${color}><b>${label}</b></color>`
        : `<color=${color}>${label}</color>`;
      return parseFormatting(markup);
    }
  });

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Compendium"
      footer="*Enter*: select  *ESC*: close"
      styledLines={treeStyledLines}
      minWidth={30}
      maxWidth={999}
      widthFraction={0.6}
      topOffset={topOffset}
    />
  );
}
