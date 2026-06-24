import React, { useCallback, useMemo, useState } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import type { FormattingNode } from "@machine-violet/shared/types/tui.js";
import type { CampaignConfig, ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import {
  CHOICE_FREQUENCY_LEVELS,
  CAMPAIGN_SCOPE_LABELS,
  DM_TURN_LENGTH_PCT_DEFAULT,
  DM_TURN_LENGTH_PCT_MIN,
  DM_TURN_LENGTH_PCT_MAX,
  DM_TURN_LENGTH_PCT_STEP,
  clampDmTurnLengthPct,
} from "@machine-violet/shared/types/config.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { CenteredModal } from "./CenteredModal.js";

/**
 * Target column width for the `Title ─────` span of a group header: the
 * trailing rule fills out to this so headers line up regardless of title
 * length (with a 2-dash floor; titles longer than this just get the floor).
 */
const GROUP_RULE_WIDTH = 18;

export interface CampaignSettingsModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  config: CampaignConfig;
  onDismiss: () => void;
  /** Persists an edited Choices Frequency. Called on Enter when the value changed. */
  onChoicesFrequencyChange?: (value: ChoiceFrequency) => void | Promise<void>;
  /** Persists an edited DM turn length (percent). Called on Enter when the value changed. */
  onDmTurnLengthPctChange?: (value: number) => void | Promise<void>;
  /**
   * Persists an edited image-generation preference. Called on Enter when
   * the value changed. The setting takes effect on the next DM turn; the
   * game-engine reads the preference per-turn when deciding whether to
   * include the generate_image tool in the DM's tool list.
   */
  onImageGenerationChange?: (value: "on" | "off") => void | Promise<void>;
  /**
   * Client-side global default applied when the campaign has no saved value.
   * Defaults to DM_TURN_LENGTH_PCT_DEFAULT (80).
   */
  globalDmTurnLengthPctDefault?: number;
  /** Opens the Roll Back Game savepoint picker (Enter on the rollback row). */
  onOpenRollback?: () => void;
}

const FREQUENCY_LABELS: Record<ChoiceFrequency, string> = {
  never: "Never",
  rarely: "Rarely",
  sometimes: "Sometimes",
  often: "Often",
  always: "Always",
};

/** Normalize the legacy "none" value on read. */
function normalize(value: string | undefined): ChoiceFrequency {
  if (value === "none" || !value) return "never";
  if ((CHOICE_FREQUENCY_LEVELS as readonly string[]).includes(value)) return value as ChoiceFrequency;
  return "never";
}

type FocusRow = "choices" | "length" | "images" | "rollback";

/** Image-gen preference normalization: only "off" is explicitly opt-out. */
function imagesOnFromConfig(value: CampaignConfig["image_generation"]): boolean {
  return value !== "off";
}

/**
 * Campaign settings shown from the in-campaign ESC menu.
 * Identity fields are read-only; Choices Frequency, DM Turn Length, and Image
 * Generation are editable; Roll Back Game is an action. ↑ / ↓ move between
 * rows; ← / → adjust the focused row.
 *
 * Laid out in colour-tinted groups (About / Preferences / Recovery), mirroring
 * the ESC menu's group-header pattern, with the focused row's label tinted +
 * bold. Uses CenteredModal's `styledLines` mode so every row is padded to
 * innerWidth and rendered opaque (a short-Text path would leave gaps that show
 * the narrative through the modal).
 */
export function CampaignSettingsModal({
  theme,
  width,
  height,
  config,
  onDismiss,
  onChoicesFrequencyChange,
  onDmTurnLengthPctChange,
  onImageGenerationChange,
  globalDmTurnLengthPctDefault,
  onOpenRollback,
}: CampaignSettingsModalProps) {
  const initialFreq = normalize(config.choices?.campaign_default);
  // Initial pct: saved per-campaign value → client global default → hard 80.
  const initialPct = clampDmTurnLengthPct(
    config.dm_turn_length_pct ?? globalDmTurnLengthPctDefault ?? DM_TURN_LENGTH_PCT_DEFAULT,
  );
  const initialImages = imagesOnFromConfig(config.image_generation);
  const [freq, setFreq] = useState<ChoiceFrequency>(initialFreq);
  const [pct, setPct] = useState<number>(initialPct);
  const [imagesOn, setImagesOn] = useState<boolean>(initialImages);
  const [focus, setFocus] = useState<FocusRow>("choices");
  const [saving, setSaving] = useState(false);
  const dirtyFreq = freq !== initialFreq;
  const dirtyPct = pct !== initialPct;
  const dirtyImages = imagesOn !== initialImages;
  const dirty = dirtyFreq || dirtyPct || dirtyImages;

  // Modal accent (the "title" colour of the complementary modal theme) — used
  // to tint group-header rules and the focused row label, matching GameMenu.
  const accentColor = useMemo(() => themeColor(deriveModalTheme(theme), "title"), [theme]);

  const commit = useCallback(async () => {
    if (!dirty) {
      onDismiss();
      return;
    }
    setSaving(true);
    try {
      const tasks: Promise<unknown>[] = [];
      if (dirtyFreq && onChoicesFrequencyChange) {
        tasks.push(Promise.resolve(onChoicesFrequencyChange(freq)));
      }
      if (dirtyPct && onDmTurnLengthPctChange) {
        tasks.push(Promise.resolve(onDmTurnLengthPctChange(pct)));
      }
      if (dirtyImages && onImageGenerationChange) {
        tasks.push(Promise.resolve(onImageGenerationChange(imagesOn ? "on" : "off")));
      }
      await Promise.all(tasks);
    } finally {
      setSaving(false);
    }
    onDismiss();
  }, [
    dirty, dirtyFreq, dirtyPct, dirtyImages,
    freq, pct, imagesOn,
    onChoicesFrequencyChange, onDmTurnLengthPctChange, onImageGenerationChange,
    onDismiss,
  ]);

  // Row order: choices → length → images. Up/down step through them;
  // left/right adjust the focused row. The images toggle treats either
  // left or right as a flip (binary state).
  const FOCUS_ORDER: FocusRow[] = ["choices", "length", "images", "rollback"];
  const stepFocus = (delta: -1 | 1) => {
    setFocus((f) => {
      const idx = FOCUS_ORDER.indexOf(f);
      const next = Math.max(0, Math.min(FOCUS_ORDER.length - 1, idx + delta));
      return FOCUS_ORDER[next];
    });
  };

  useInput((_input, key) => {
    if (saving) return;
    if (key.upArrow) { stepFocus(-1); return; }
    if (key.downArrow) { stepFocus(1); return; }
    if (key.leftArrow) {
      if (focus === "choices") {
        setFreq((f) => {
          const idx = CHOICE_FREQUENCY_LEVELS.indexOf(f);
          return CHOICE_FREQUENCY_LEVELS[Math.max(0, idx - 1)];
        });
      } else if (focus === "length") {
        setPct((p) => Math.max(DM_TURN_LENGTH_PCT_MIN, p - DM_TURN_LENGTH_PCT_STEP));
      } else if (focus === "images") {
        setImagesOn((v) => !v);
      }
      // "rollback" is an action row — left/right do nothing.
      return;
    }
    if (key.rightArrow) {
      if (focus === "choices") {
        setFreq((f) => {
          const idx = CHOICE_FREQUENCY_LEVELS.indexOf(f);
          return CHOICE_FREQUENCY_LEVELS[Math.min(CHOICE_FREQUENCY_LEVELS.length - 1, idx + 1)];
        });
      } else if (focus === "length") {
        setPct((p) => Math.min(DM_TURN_LENGTH_PCT_MAX, p + DM_TURN_LENGTH_PCT_STEP));
      } else if (focus === "images") {
        setImagesOn((v) => !v);
      }
      return;
    }
    if (key.return) {
      // Enter on the rollback row opens the picker; on any value row it saves.
      if (focus === "rollback") { onOpenRollback?.(); return; }
      void commit();
      return;
    }
    if (key.escape) { onDismiss(); return; }
  });

  // Choices Frequency slider line.
  const freqSegments = CHOICE_FREQUENCY_LEVELS.map((level) => {
    const label = FREQUENCY_LABELS[level];
    return level === freq ? `[${label}]` : ` ${label} `;
  });
  const freqArrows = focus === "choices" ? "◂" : " ";
  const freqArrowsR = focus === "choices" ? "▸" : " ";
  const freqLine = `  ${freqArrows} ${freqSegments.join(" ")} ${freqArrowsR}`;

  // DM Turn Length line — shown as "[ 80% ]" with arrows when focused.
  const pctArrows = focus === "length" ? "◂" : " ";
  const pctArrowsR = focus === "length" ? "▸" : " ";
  const pctValue = focus === "length" ? `[${pct}%]` : ` ${pct}% `;
  const pctLine = `  ${pctArrows} ${pctValue} ${pctArrowsR}    (range ${DM_TURN_LENGTH_PCT_MIN}–${DM_TURN_LENGTH_PCT_MAX}%, default ${DM_TURN_LENGTH_PCT_DEFAULT}%)`;

  // Image Generation toggle — shown as "[On]" / "[Off]" with arrows when focused.
  const imgArrows = focus === "images" ? "◂" : " ";
  const imgArrowsR = focus === "images" ? "▸" : " ";
  const imgLabel = imagesOn ? "On" : "Off";
  const imgValue = focus === "images" ? `[${imgLabel}]` : ` ${imgLabel} `;
  const imgLine = `  ${imgArrows} ${imgValue} ${imgArrowsR}`;

  const hintLine = saving
    ? "  Saving..."
    : dirty
      ? "  Enter saves · ESC cancels · ↑ / ↓ rows · ← / → adjust"
      : "  ↑ / ↓ rows · ← / → adjust · Enter to close";

  // --- Styled layout: colour-tinted group headers + focus-highlighted labels,
  // mirroring the ESC menu (GameMenu). Plain strings are valid FormattingNodes,
  // so only the header rules and focused labels carry styling. ---
  const lines: FormattingNode[][] = [];
  const plain = (text: string) => lines.push([text]);
  /** A `── Title ─────` rule tinted in the modal accent, like GameMenu groups. */
  const header = (title: string) => {
    const tail = Math.max(2, GROUP_RULE_WIDTH - title.length);
    const text = `  ── ${title} ${"─".repeat(tail)}`;
    lines.push(accentColor ? [{ type: "color", color: accentColor, content: [text] }] : [text]);
  };
  /** A setting/action label, prefixed with ▶ and bold (+ accent-tinted) when focused. */
  const label = (text: string, focused: boolean) => {
    const row = focused ? `  ▶ ${text}` : `    ${text}`;
    if (!focused) {
      lines.push([row]);
      return;
    }
    // Bold always conveys focus; the accent tint is layered on when the theme
    // resolves a "title" colour (it can be undefined — don't drop bold with it).
    const bolded: FormattingNode = { type: "bold", content: [row] };
    lines.push([accentColor ? { type: "color", color: accentColor, content: [bolded] } : bolded]);
  };

  header("About");
  plain(`  Campaign:   ${config.name}`);
  if (config.system) plain(`  System:     ${config.system}`);
  if (config.genre) plain(`  Genre:      ${config.genre}`);
  if (config.mood) plain(`  Mood:       ${config.mood}`);
  if (config.difficulty) plain(`  Difficulty: ${config.difficulty}`);
  if (config.campaign_scope) {
    const scopeLabel = CAMPAIGN_SCOPE_LABELS[config.campaign_scope];
    if (scopeLabel) plain(`  Scope:      ${scopeLabel}`);
  }
  plain("");

  header("Preferences");
  label("Choices Frequency", focus === "choices");
  plain("    How often the DM offers suggested replies.");
  plain(freqLine);
  plain("");
  label("DM Turn Length", focus === "length");
  plain("    Page-size hint — lower = tighter prose.");
  plain(pctLine);
  plain("");
  label("Image Generation", focus === "images");
  plain("    Let the DM illustrate scenes inline.");
  plain(imgLine);
  plain("");

  header("Recovery");
  label("Roll Back Game", focus === "rollback");
  plain("    Restore an earlier savepoint. Your game is");
  plain("    archived first, so it stays recoverable.");
  plain(focus === "rollback" ? "    Enter to choose a savepoint…" : "");
  plain("");
  plain(hintLine);

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Campaign Settings"
      minWidth={56}
      maxWidth={72}
      widthFraction={0.7}
      styledLines={lines}
    />
  );
}
