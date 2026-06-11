import { describe, it, expect, afterEach } from "vitest";
import { e2eActive, e2eConnectionStore, E2E_HEALTH } from "./e2e.js";

describe("e2e harness affordances", () => {
  afterEach(() => { delete process.env.MV_E2E; });

  it("e2eActive() reflects MV_E2E=1 exactly", () => {
    delete process.env.MV_E2E;
    expect(e2eActive()).toBe(false);
    process.env.MV_E2E = "1";
    expect(e2eActive()).toBe(true);
    process.env.MV_E2E = "0";
    expect(e2eActive()).toBe(false);
  });

  it("synthetic store is one valid connection with every tier assigned to it", () => {
    const store = e2eConnectionStore();
    expect(store.connections).toHaveLength(1);
    const [conn] = store.connections;
    expect(conn.source).toBe("env"); // env source → never persisted by saveConnectionStore
    for (const tier of ["large", "medium", "small"] as const) {
      const assignment = store.tierAssignments[tier];
      expect(assignment?.connectionId).toBe(conn.id);
      // the assigned model actually exists on the connection (matches getTierProvider's lookup)
      expect(conn.models.some((m) => m.id === assignment!.modelId)).toBe(true);
    }
  });

  it("synthetic health verdict is valid", () => {
    expect(E2E_HEALTH.status).toBe("valid");
  });
});
