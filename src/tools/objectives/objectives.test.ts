import { describe, it, expect, beforeEach } from "vitest";
import { createObjectivesState, manageObjectives } from "./index.js";
import type { ObjectivesState } from "../../types/objectives.js";

let state: ObjectivesState;

beforeEach(() => {
  state = createObjectivesState();
});

describe("createObjectivesState", () => {
  it("creates empty state", () => {
    expect(state.objectives).toEqual({});
    expect(state.next_id).toBe(1);
  });
});

describe("manage_objectives — create", () => {
  it("creates an objective with auto-incremented id", () => {
    const r = manageObjectives(state, 1, {
      action: "create",
      title: "Find the lost temple",
      description: "Locate the ancient temple in the Ashen Wastes.",
    });
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty("message", "Created obj-1: Find the lost temple");
    expect(state.objectives["obj-1"]).toMatchObject({
      id: "obj-1",
      title: "Find the lost temple",
      status: "active",
      created_scene: 1,
    });
    expect(state.next_id).toBe(2);
  });

  it("auto-increments ids across multiple creates", () => {
    manageObjectives(state, 1, { action: "create", title: "A", description: "a" });
    manageObjectives(state, 2, { action: "create", title: "B", description: "b" });
    expect(state.objectives["obj-1"]).toBeDefined();
    expect(state.objectives["obj-2"]).toBeDefined();
    expect(state.next_id).toBe(3);
  });

  it("errors when title is missing", () => {
    const r = manageObjectives(state, 1, { action: "create", description: "desc" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "title is required");
  });

  it("errors when description is missing", () => {
    const r = manageObjectives(state, 1, { action: "create", title: "T" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "description is required");
  });
});

describe("manage_objectives — update", () => {
  beforeEach(() => {
    manageObjectives(state, 1, { action: "create", title: "Original", description: "original desc" });
  });

  it("updates title and description", () => {
    const r = manageObjectives(state, 2, {
      action: "update",
      id: "obj-1",
      title: "Revised",
      description: "revised desc",
    });
    expect(r.ok).toBe(true);
    expect(state.objectives["obj-1"].title).toBe("Revised");
    expect(state.objectives["obj-1"].description).toBe("revised desc");
  });

  it("updates title only", () => {
    manageObjectives(state, 2, { action: "update", id: "obj-1", title: "New title" });
    expect(state.objectives["obj-1"].title).toBe("New title");
    expect(state.objectives["obj-1"].description).toBe("original desc");
  });

  it("errors when id is missing", () => {
    const r = manageObjectives(state, 2, { action: "update", title: "X" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "id is required");
  });

  it("errors when no fields to update", () => {
    const r = manageObjectives(state, 2, { action: "update", id: "obj-1" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "nothing to update — provide title or description");
  });

  it("errors when objective not found", () => {
    const r = manageObjectives(state, 2, { action: "update", id: "obj-99" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "Objective obj-99 not found");
  });

  it("errors when objective is already resolved", () => {
    manageObjectives(state, 2, { action: "complete", id: "obj-1" });
    const r = manageObjectives(state, 3, { action: "update", id: "obj-1", title: "X" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "Objective obj-1 is already completed");
  });
});

describe("manage_objectives — resolve", () => {
  beforeEach(() => {
    manageObjectives(state, 1, { action: "create", title: "Quest", description: "desc" });
  });

  it("completes an objective", () => {
    const r = manageObjectives(state, 3, { action: "complete", id: "obj-1" });
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty("message", "Completed obj-1: Quest");
    expect(state.objectives["obj-1"].status).toBe("completed");
    expect(state.objectives["obj-1"].resolved_scene).toBe(3);
  });

  it("fails an objective", () => {
    const r = manageObjectives(state, 4, { action: "fail", id: "obj-1" });
    expect(r.ok).toBe(true);
    expect(state.objectives["obj-1"].status).toBe("failed");
    expect(state.objectives["obj-1"].resolved_scene).toBe(4);
  });

  it("abandons an objective", () => {
    const r = manageObjectives(state, 5, { action: "abandon", id: "obj-1" });
    expect(r.ok).toBe(true);
    expect(state.objectives["obj-1"].status).toBe("abandoned");
  });

  it("errors when resolving an already-resolved objective", () => {
    manageObjectives(state, 3, { action: "complete", id: "obj-1" });
    const r = manageObjectives(state, 4, { action: "fail", id: "obj-1" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "Objective obj-1 is already completed");
  });

  it("errors when id is missing", () => {
    const r = manageObjectives(state, 3, { action: "complete" });
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty("error", "id is required");
  });
});

describe("manage_objectives — list", () => {
  it("returns message for empty state", () => {
    const r = manageObjectives(state, 1, { action: "list" });
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty("message", "No objectives.");
  });

  it("groups objectives by status", () => {
    manageObjectives(state, 1, { action: "create", title: "Active quest", description: "still going" });
    manageObjectives(state, 1, { action: "create", title: "Done quest", description: "finished" });
    manageObjectives(state, 2, { action: "complete", id: "obj-2" });

    const r = manageObjectives(state, 3, { action: "list" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain("Active:");
      expect(r.message).toContain("Active quest");
      expect(r.message).toContain("Completed:");
      expect(r.message).toContain("Done quest");
    }
  });
});
