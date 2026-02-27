import type { FileCategory } from "../../shared/protocol";

/** Human-readable labels for file categories. */
export const CATEGORY_LABELS: Record<FileCategory, string> = {
  state: "State",
  entity: "Entities",
  transcript: "Transcripts",
  "context-dump": "Context Dumps",
  thinking: "Thinking Traces",
  map: "Maps",
  config: "Config",
  other: "Other",
};

/** Display order for categories in the sidebar. */
export const CATEGORY_ORDER: FileCategory[] = [
  "config",
  "state",
  "transcript",
  "entity",
  "context-dump",
  "thinking",
  "map",
  "other",
];

/** CSS color for category labels. */
export const CATEGORY_COLORS: Record<FileCategory, string> = {
  state: "#4fc3f7",
  entity: "#81c784",
  transcript: "#ffb74d",
  "context-dump": "#ce93d8",
  thinking: "#f48fb1",
  map: "#a1887f",
  config: "#90a4ae",
  other: "#e0e0e0",
};
