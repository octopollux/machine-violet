import type { FileCategory } from "../../shared/protocol";

/** Human-readable labels for file categories. */
export const CATEGORY_LABELS: Record<FileCategory, string> = {
  state: "State",
  characters: "Characters",
  players: "Players",
  locations: "Locations",
  factions: "Factions",
  lore: "Lore",
  rules: "Rules",
  transcript: "Transcripts",
  "context-dump": "Context Dumps",
  thinking: "Thinking Traces",
  map: "Maps",
  config: "Config",
  logs: "Logs",
  other: "Other",
};

/** Display order for categories in the sidebar. */
export const CATEGORY_ORDER: FileCategory[] = [
  "config",
  "state",
  "transcript",
  "characters",
  "players",
  "locations",
  "factions",
  "lore",
  "rules",
  "context-dump",
  "thinking",
  "map",
  "logs",
  "other",
];

/** CSS color for category labels. */
export const CATEGORY_COLORS: Record<FileCategory, string> = {
  state: "#4fc3f7",
  characters: "#81c784",
  players: "#a5d6a7",
  locations: "#fff176",
  factions: "#ffcc80",
  lore: "#b39ddb",
  rules: "#80cbc4",
  transcript: "#ffb74d",
  "context-dump": "#ce93d8",
  thinking: "#f48fb1",
  map: "#a1887f",
  config: "#90a4ae",
  logs: "#ef5350",
  other: "#e0e0e0",
};
