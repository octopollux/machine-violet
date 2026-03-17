import type { ObjectivesState, Objective } from "../../types/objectives.js";

/** Create empty objectives state. */
export function createObjectivesState(): ObjectivesState {
  return { objectives: {}, next_id: 1, current_scene: 1 };
}

export interface ManageObjectivesInput {
  action: "create" | "update" | "complete" | "fail" | "abandon" | "list";
  id?: string;
  title?: string;
  description?: string;
}

export interface ManageObjectivesResult {
  ok: true;
  message: string;
}

export interface ManageObjectivesError {
  ok: false;
  error: string;
}

type Result = ManageObjectivesResult | ManageObjectivesError;

/** Single entry point for all objective mutations and queries. */
export function manageObjectives(
  state: ObjectivesState,
  sceneNumber: number,
  input: ManageObjectivesInput,
): Result {
  switch (input.action) {
    case "create":
      return createObjective(state, sceneNumber, input);
    case "update":
      return updateObjective(state, input);
    case "complete":
      return resolveObjective(state, sceneNumber, input.id, "completed");
    case "fail":
      return resolveObjective(state, sceneNumber, input.id, "failed");
    case "abandon":
      return resolveObjective(state, sceneNumber, input.id, "abandoned");
    case "list":
      return listObjectives(state);
    default:
      return { ok: false, error: `Unknown action: ${input.action}` };
  }
}

function createObjective(
  state: ObjectivesState,
  sceneNumber: number,
  input: ManageObjectivesInput,
): Result {
  if (!input.title) return { ok: false, error: "title is required" };
  if (!input.description) return { ok: false, error: "description is required" };

  const id = `obj-${state.next_id}`;
  const objective: Objective = {
    id,
    title: input.title,
    description: input.description,
    status: "active",
    created_scene: sceneNumber,
  };
  state.objectives[id] = objective;
  state.next_id++;
  return { ok: true, message: `Created ${id}: ${objective.title}` };
}

function updateObjective(
  state: ObjectivesState,
  input: ManageObjectivesInput,
): Result {
  if (!input.id) return { ok: false, error: "id is required" };
  const obj = state.objectives[input.id];
  if (!obj) return { ok: false, error: `Objective ${input.id} not found` };
  if (obj.status !== "active") return { ok: false, error: `Objective ${input.id} is already ${obj.status}` };

  if (input.title) obj.title = input.title;
  if (input.description) obj.description = input.description;
  return { ok: true, message: `Updated ${obj.id}: ${obj.title}` };
}

function resolveObjective(
  state: ObjectivesState,
  sceneNumber: number,
  id: string | undefined,
  status: "completed" | "failed" | "abandoned",
): Result {
  if (!id) return { ok: false, error: "id is required" };
  const obj = state.objectives[id];
  if (!obj) return { ok: false, error: `Objective ${id} not found` };
  if (obj.status !== "active") return { ok: false, error: `Objective ${id} is already ${obj.status}` };

  obj.status = status;
  obj.resolved_scene = sceneNumber;
  return { ok: true, message: `${capitalize(status)} ${obj.id}: ${obj.title}` };
}

function listObjectives(state: ObjectivesState): Result {
  const all = Object.values(state.objectives);
  if (all.length === 0) return { ok: true, message: "No objectives." };

  const groups: Record<string, Objective[]> = {};
  for (const obj of all) {
    (groups[obj.status] ??= []).push(obj);
  }

  const lines: string[] = [];
  for (const status of ["active", "completed", "failed", "abandoned"] as const) {
    const group = groups[status];
    if (!group) continue;
    lines.push(`${capitalize(status)}:`);
    for (const obj of group) {
      lines.push(`  ${obj.id}: ${obj.title} — ${obj.description}`);
    }
  }
  return { ok: true, message: lines.join("\n") };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
