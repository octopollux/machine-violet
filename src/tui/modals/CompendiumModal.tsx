import { useState, useMemo, useCallback, useEffect } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import type { FormattingNode } from "../../types/tui.js";
import { CenteredModal } from "./CenteredModal.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { parseFormatting } from "../formatting.js";
import type {
  Compendium,
  CompendiumEntry,
  CompendiumCategory,
} from "../../types/compendium.js";
import { COMPENDIUM_CATEGORIES } from "../../types/compendium.js";

const CATEGORY_LABELS: Record<CompendiumCategory, string> = {
  characters: "Characters",
  places: "Places",
  storyline: "Storyline",
  lore: "Lore",
  objectives: "Objectives",
};

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
 * Categories expand/collapse; selecting an entry shows its detail view.
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

  // Build the flat list of visible rows
  const rows: TreeRow[] = useMemo(() => {
    const result: TreeRow[] = [];
    for (const cat of COMPENDIUM_CATEGORIES) {
      const entries = data[cat];
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

  useInput((_input, key) => {
    if (detail) {
      // Detail view: ESC or Enter goes back to tree
      if (key.escape || key.return) {
        setDetail(null);
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
        setDetail(row.entry);
      }
      return;
    }
  });

  const modalTheme = useMemo(() => deriveModalTheme(theme), [theme]);
  const textColor = themeColor(modalTheme, "sideFrame");
  const accentColor = themeColor(modalTheme, "title");

  // --- Detail view ---
  if (detail) {
    const detailLines: string[] = [];
    detailLines.push("");
    detailLines.push(detail.summary || "(No information yet.)");
    detailLines.push("");
    if (detail.aliases && detail.aliases.length > 0) {
      detailLines.push(`Also known as: ${detail.aliases.join(", ")}`);
    }
    const sceneLine = detail.firstScene === detail.lastScene
      ? `Scene ${detail.firstScene}`
      : `Scenes ${detail.firstScene}-${detail.lastScene}`;
    detailLines.push(sceneLine);
    if (detail.related.length > 0) {
      detailLines.push(`Related: ${detail.related.join(", ")}`);
    }
    detailLines.push("");
    detailLines.push("ESC to go back");

    return (
      <CenteredModal
        theme={theme}
        width={width}
        height={height}
        title={detail.name}
        lines={detailLines}
        minWidth={30}
        maxWidth={999}
        widthFraction={0.6}
        topOffset={topOffset}
      />
    );
  }

  // --- Tree view ---
  const isEmpty = COMPENDIUM_CATEGORIES.every((cat) => data[cat].length === 0);

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
      const arrow = row.expanded ? "\u25BE" : "\u25B8";
      const prefix = selected ? "\u25C6 " : "  ";
      const label = `${prefix}${arrow} ${row.label} (${row.count})`;
      const markup = selected
        ? `<color=${color}><b>${label}</b></color>`
        : `<color=${color}>${label}</color>`;
      return parseFormatting(markup);
    } else {
      const marker = selected ? "\u25C6" : "\u25CB";
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
      footer="Enter: select  ESC: close"
      styledLines={treeStyledLines}
      minWidth={30}
      maxWidth={999}
      widthFraction={0.6}
      topOffset={topOffset}
    />
  );
}
