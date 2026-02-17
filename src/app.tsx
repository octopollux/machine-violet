import React, { useState } from "react";
import { useStdout, useInput } from "ink";
import { Layout } from "./tui/layout.js";
import { STYLES } from "./tui/frames/index.js";
import type { StyleVariant } from "./types/tui.js";

const VARIANTS: StyleVariant[] = ["exploration", "combat", "ooc", "levelup"];

const DEMO_NARRATIVE = [
  "Welcome to the TUI-RPG demo.",
  "",
  "The door groans open onto a long hall lit by guttering candles,",
  "the air thick with dust and something sweeter underneath.",
  "At the far end, a figure sits motionless in a high-backed chair.",
  "",
  "<b>The figure raises its head.</b>",
  "",
  '<color=#cc4444>"You should not have come here,"</color> it whispers.',
  "",
  "Press <b>S</b> to cycle styles, <b>V</b> to cycle variants, <b>Q</b> to quit.",
];

export default function App() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  const [styleIdx, setStyleIdx] = useState(0);
  const [variantIdx, setVariantIdx] = useState(0);

  useInput((input, key) => {
    if (input === "s" || input === "S") {
      setStyleIdx((i) => (i + 1) % STYLES.length);
    }
    if (input === "v" || input === "V") {
      setVariantIdx((i) => (i + 1) % VARIANTS.length);
    }
    if (input === "q" || input === "Q" || key.escape) {
      process.exit(0);
    }
  });

  const style = STYLES[styleIdx];
  const variant = VARIANTS[variantIdx];

  return (
    <Layout
      dimensions={{ columns: cols, rows }}
      style={style}
      variant={variant}
      narrativeLines={DEMO_NARRATIVE}
      modelineText={`HP: 42/42 | Loc: The Shattered Hall | Style: ${style.name} / ${variant}`}
      inputValue=""
      activeCharacterName="Aldric"
      players={[
        { name: "Aldric", isAI: false },
        { name: "Sable", isAI: false },
        { name: "Rook", isAI: true },
      ]}
      activePlayerIndex={0}
      campaignName="The Shattered Crown"
      resources={["HP: 42/42", "Mana: 7/12"]}
      turnHolder="Aldric"
      engineState={null}
    />
  );
}
