import React, { useCallback, useState } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import type { CampaignConfig, ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import { CHOICE_FREQUENCY_LEVELS } from "@machine-violet/shared/types/config.js";
import { CenteredModal } from "./CenteredModal.js";

export interface CampaignSettingsModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  config: CampaignConfig;
  onDismiss: () => void;
  /** Persists an edited Choices Frequency. Called on Enter when the value changed. */
  onChoicesFrequencyChange?: (value: ChoiceFrequency) => void | Promise<void>;
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

/**
 * Campaign settings shown from the in-campaign ESC menu.
 * Identity fields are read-only; Choices Frequency is editable with ← / →.
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
}: CampaignSettingsModalProps) {
  const initial = normalize(config.choices?.campaign_default);
  const [freq, setFreq] = useState<ChoiceFrequency>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = freq !== initial;

  const commit = useCallback(async () => {
    if (dirty && onChoicesFrequencyChange) {
      setSaving(true);
      try {
        await onChoicesFrequencyChange(freq);
      } finally {
        setSaving(false);
      }
    }
    onDismiss();
  }, [dirty, freq, onChoicesFrequencyChange, onDismiss]);

  useInput((_input, key) => {
    if (saving) return;
    if (key.leftArrow) {
      setFreq((f) => {
        const idx = CHOICE_FREQUENCY_LEVELS.indexOf(f);
        return CHOICE_FREQUENCY_LEVELS[Math.max(0, idx - 1)];
      });
      return;
    }
    if (key.rightArrow) {
      setFreq((f) => {
        const idx = CHOICE_FREQUENCY_LEVELS.indexOf(f);
        return CHOICE_FREQUENCY_LEVELS[Math.min(CHOICE_FREQUENCY_LEVELS.length - 1, idx + 1)];
      });
      return;
    }
    if (key.return) { void commit(); return; }
    if (key.escape) { onDismiss(); return; }
  });

  // Build the slider line: ◂  Never  Rarely  [Sometimes]  Often  Always  ▸
  // Each segment uses matching space-padding (" Sometimes " vs "[Sometimes]")
  // so the line width doesn't shift as the user moves between selections.
  const sliderSegments = CHOICE_FREQUENCY_LEVELS.map((level) => {
    const label = FREQUENCY_LABELS[level];
    return level === freq ? `[${label}]` : ` ${label} `;
  });
  const sliderLine = `  ◂ ${sliderSegments.join(" ")} ▸`;

  const hintLine = saving
    ? "  Saving..."
    : dirty
      ? "  Enter saves · ESC cancels"
      : "  ← / → to adjust · Enter to close";

  const lines: string[] = [];
  lines.push(`  Campaign:   ${config.name}`);
  if (config.system) lines.push(`  System:     ${config.system}`);
  if (config.genre) lines.push(`  Genre:      ${config.genre}`);
  if (config.mood) lines.push(`  Mood:       ${config.mood}`);
  if (config.difficulty) lines.push(`  Difficulty: ${config.difficulty}`);
  lines.push("");
  lines.push("  Choices Frequency");
  lines.push("    How often the DM offers you a set of suggested responses.");
  lines.push("");
  lines.push(sliderLine);
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
