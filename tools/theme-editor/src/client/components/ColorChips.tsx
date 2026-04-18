import type { HarmonyType } from "@engine-src/tui/color/index.js";
import { listPresets, listGradients } from "@engine-src/tui/color/index.js";

const HARMONIES: HarmonyType[] = [
  "analogous",
  "complementary",
  "split-complementary",
  "triadic",
  "tetradic",
];

interface ColorChipsProps {
  preset: string | undefined;
  harmony: string | undefined;
  gradient: string | "none" | undefined;
  onSet: (key: "preset" | "harmony" | "gradient", value: string) => void;
}

interface ChipRowProps {
  label: string;
  options: readonly string[];
  current: string | undefined;
  onClick: (value: string) => void;
}

function ChipRow({ label, options, current, onClick }: ChipRowProps) {
  return (
    <div className="chip-row">
      <span className="chip-label">{label}</span>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`chip${opt === current ? " chip-active" : ""}`}
          onClick={() => onClick(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export function ColorChips({ preset, harmony, gradient, onSet }: ColorChipsProps) {
  const presets = listPresets();
  const gradients = [...listGradients(), "none"];

  return (
    <div className="color-chips">
      <ChipRow
        label="preset"
        options={presets}
        current={preset}
        onClick={(v) => onSet("preset", v)}
      />
      <ChipRow
        label="harmony"
        options={HARMONIES}
        current={harmony}
        onClick={(v) => onSet("harmony", v)}
      />
      <ChipRow
        label="gradient"
        options={gradients}
        current={gradient}
        onClick={(v) => onSet("gradient", v)}
      />
    </div>
  );
}
