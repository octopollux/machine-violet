import React, { useCallback, useState } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
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
import { CenteredModal } from "./CenteredModal.js";

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

type FocusRow = "choices" | "length" | "images";

/** Image-gen preference normalization: only "off" is explicitly opt-out. */
function imagesOnFromConfig(value: CampaignConfig["image_generation"]): boolean {
  return value !== "off";
}

/**
 * Campaign settings shown from the in-campaign ESC menu.
 * Identity fields are read-only; Choices Frequency and DM Turn Length are
 * editable. ↑ / ↓ move between rows; ← / → adjust the focused row.
 *
 * Uses CenteredModal's plain-text `lines` mode so every row is padded to
 * innerWidth and rendered opaque — the children-with-short-Text path leaves
 * gaps to the right of each line, which shows the narrative through the modal.
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
  const FOCUS_ORDER: FocusRow[] = ["choices", "length", "images"];
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
      } else {
        setImagesOn((v) => !v);
      }
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
      } else {
        setImagesOn((v) => !v);
      }
      return;
    }
    if (key.return) { void commit(); return; }
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

  const lines: string[] = [];
  lines.push(`  Campaign:   ${config.name}`);
  if (config.system) lines.push(`  System:     ${config.system}`);
  if (config.genre) lines.push(`  Genre:      ${config.genre}`);
  if (config.mood) lines.push(`  Mood:       ${config.mood}`);
  if (config.difficulty) lines.push(`  Difficulty: ${config.difficulty}`);
  if (config.campaign_scope) {
    const scopeLabel = CAMPAIGN_SCOPE_LABELS[config.campaign_scope];
    if (scopeLabel) lines.push(`  Scope:      ${scopeLabel}`);
  }
  lines.push("");
  lines.push(focus === "choices" ? "  ▶ Choices Frequency" : "    Choices Frequency");
  lines.push("    How often the DM offers you a set of suggested responses.");
  lines.push("");
  lines.push(freqLine);
  lines.push("");
  lines.push(focus === "length" ? "  ▶ DM Turn Length" : "    DM Turn Length");
  lines.push("    Page size the DM is told about. Lower = tighter prose;");
  lines.push("    100% = actual size. 80% is a useful starting nudge.");
  lines.push("");
  lines.push(pctLine);
  lines.push("");
  lines.push(focus === "images" ? "  ▶ Image Generation" : "    Image Generation");
  lines.push("    When on, the DM can illustrate moments inline. Requires");
  lines.push("    a provider/model that supports image generation.");
  lines.push("");
  lines.push(imgLine);
  lines.push("");
  lines.push(hintLine);

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Campaign Settings"
      minWidth={56}
      maxWidth={72}
      widthFraction={0.7}
      lines={lines}
    />
  );
}
