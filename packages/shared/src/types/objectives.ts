/** A long-lifecycle player-facing goal (quest, mission, etc.). */
export interface Objective {
  id: string;
  title: string;
  description: string;
  status: "active" | "completed" | "failed" | "abandoned";
  /** Scene number when created */
  created_scene: number;
  /** Scene number when resolved (completed/failed/abandoned) */
  resolved_scene?: number;
}

/** Mutable objectives state — persisted to state/objectives.json */
export interface ObjectivesState {
  objectives: Record<string, Objective>;
  next_id: number;
  /** Current scene number — kept in sync by the scene manager. */
  current_scene: number;
}
