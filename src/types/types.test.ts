import { describe, it, expect } from "vitest";
import type { DiceRollResult, MapData, ClocksState, CombatState } from "./index.js";

describe("type sanity checks", () => {
  it("DiceRollResult has expected shape", () => {
    const result: DiceRollResult = {
      expression: "2d6+3",
      rolls: [4, 5],
      modifier: 3,
      total: 12,
    };
    expect(result.total).toBe(12);
    expect(result.rolls).toHaveLength(2);
  });

  it("MapData has expected shape", () => {
    const map: MapData = {
      id: "test-map",
      gridType: "square",
      bounds: { width: 10, height: 10 },
      defaultTerrain: "grass",
      regions: [],
      terrain: {},
      entities: {},
      annotations: {},
      links: [],
      meta: {},
    };
    expect(map.id).toBe("test-map");
    expect(map.gridType).toBe("square");
  });

  it("ClocksState has expected shape", () => {
    const clocks: ClocksState = {
      calendar: {
        current: 0,
        alarms: [],
        epoch: "campaign start",
        display_format: "day+time",
      },
      combat: {
        current: 0,
        alarms: [],
        active: false,
      },
    };
    expect(clocks.calendar.current).toBe(0);
    expect(clocks.combat.active).toBe(false);
  });

  it("CombatState has expected shape", () => {
    const combat: CombatState = {
      active: true,
      order: [{ id: "aldric", initiative: 14, type: "pc" }],
      round: 1,
      currentTurn: 0,
    };
    expect(combat.order).toHaveLength(1);
    expect(combat.round).toBe(1);
  });
});
