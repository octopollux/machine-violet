import React, { useState, useMemo, useEffect } from "react";
import { useInput } from "ink";
import type { UsageStatus } from "@machine-violet/shared";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { ResolvedTheme } from "../themes/types.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { CenteredModal } from "./CenteredModal.js";

export interface MenuItem {
  key: string;
  label: string;
  action: () => void;
}

export interface MenuGroup {
  title: string;
  items: MenuItem[];
}

interface GameMenuProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  groups: MenuGroup[];
  tokenSummary?: string;
  usageStatus?: UsageStatus | null;
  onDismiss: () => void;
}

/**
 * Build the footer string: token tier stats, then (only when the active
 * provider exposes a primary `percentage` usage segment) a separator and
 * the `<remaining>%` figure. We invert the provider's `usedPercent` so
 * the displayed value matches the gem-gauge semantics (how much
 * headroom is left, not how much has been spent).
 */
function buildFooter(tokenSummary: string | undefined, usage: UsageStatus | null | undefined): string | undefined {
  if (!tokenSummary) return tokenSummary;
  const primary = usage?.segments.find((s) => s.id === "primary");
  if (!primary || primary.kind !== "percentage" || primary.usedPercent === undefined) {
    return tokenSummary;
  }
  const remaining = Math.max(0, Math.min(100, Math.round(100 - primary.usedPercent)));
  return `${tokenSummary} | ${remaining}%`;
}

/** Fixed visual width for the group-header rule, in columns of `─`. */
const GROUP_RULE_WIDTH = 15;

function groupHeaderLine(title: string): string {
  const tail = Math.max(2, GROUP_RULE_WIDTH - title.length);
  return `  ── ${title} ${"─".repeat(tail)}`;
}

/**
 * ESC menu modal. Renders grouped items with separator headers; arrow
 * keys move across the flattened selectable list, skipping group rows.
 */
export function GameMenu({
  theme,
  width,
  height,
  groups,
  tokenSummary,
  usageStatus,
  onDismiss,
}: GameMenuProps) {
  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const [menuIndex, setMenuIndex] = useState(0);

  // Clamp if the items array shrinks across renders (e.g. dev mode toggled off).
  useEffect(() => {
    setMenuIndex((i) => Math.min(i, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  useInput((_input, key) => {
    if (key.escape) { onDismiss(); return; }
    if (key.upArrow) { setMenuIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setMenuIndex((i) => Math.min(flatItems.length - 1, i + 1)); return; }
    if (key.return) {
      const item = flatItems[menuIndex];
      onDismiss();
      item?.action();
      return;
    }
  });

  // Group headers want the modal's accent (title) color so they read as
  // structural rules rather than dim equals. Derive the modal theme the
  // same way CenteredModal does internally so the header tint matches the
  // "Menu" title in the top border.
  const accentColor = useMemo(() => themeColor(deriveModalTheme(theme), "title"), [theme]);

  const styledLines: FormattingNode[][] = [];
  let flatIdx = 0;
  for (const group of groups) {
    const headerText = groupHeaderLine(group.title);
    styledLines.push(
      accentColor
        ? [{ type: "color", color: accentColor, content: [headerText] }]
        : [headerText],
    );
    for (const item of group.items) {
      const marker = flatIdx === menuIndex ? "◆" : "○";
      styledLines.push([`   ${marker} ${item.label}`]);
      flatIdx++;
    }
  }

  const footer = buildFooter(tokenSummary, usageStatus);
  return <CenteredModal theme={theme} width={width} height={height} title="Menu" footer={footer} styledLines={styledLines} minWidth={48} />;
}
