import { describe, it, expect, beforeEach } from "vitest";
import {
  createClocksState,
  parseTimeString,
  formatCalendarTime,
  setAlarm,
  clearAlarm,
  advanceCalendar,
  nextRound,
  startCombat,
  endCombat,
  checkClocks,
  resetAlarmCounter,
} from "./index.js";
import type { ClocksState } from "../../types/clocks.js";

let state: ClocksState;

beforeEach(() => {
  state = createClocksState();
  resetAlarmCounter();
});

describe("parseTimeString", () => {
  it("parses minutes", () => {
    expect(parseTimeString("30 minutes")).toBe(30);
    expect(parseTimeString("1 minute")).toBe(1);
  });

  it("parses hours", () => {
    expect(parseTimeString("6 hours")).toBe(360);
    expect(parseTimeString("1 hour")).toBe(60);
  });

  it("parses days", () => {
    expect(parseTimeString("3 days")).toBe(4320);
    expect(parseTimeString("1 day")).toBe(1440);
  });

  it("parses weeks", () => {
    expect(parseTimeString("1 week")).toBe(10080);
  });

  it("rejects invalid input", () => {
    expect(() => parseTimeString("banana")).toThrow("Cannot parse");
    expect(() => parseTimeString("3 fortnights")).toThrow("Cannot parse");
  });
});

describe("formatCalendarTime", () => {
  it("formats day+time", () => {
    expect(formatCalendarTime(0, "day+time")).toBe("Day 1, night");
    expect(formatCalendarTime(480, "day+time")).toBe("Day 1, morning"); // 8am
    expect(formatCalendarTime(840, "day+time")).toBe("Day 1, afternoon"); // 2pm
    expect(formatCalendarTime(1440, "day+time")).toBe("Day 2, night"); // midnight day 2
    expect(formatCalendarTime(1920, "day+time")).toBe("Day 2, morning"); // 8am day 2
  });

  it("formats abstract", () => {
    expect(formatCalendarTime(47, "abstract")).toBe("Turn 47");
  });
});

describe("setAlarm", () => {
  it("sets a calendar alarm with string duration", () => {
    const result = setAlarm(state, {
      clock: "calendar",
      in: "3 days",
      message: "Orc warband arrives",
    });
    expect(result.id).toBe("alarm-001");
    expect(result.fires_at).toBe(4320);
    expect(result.display).toBeDefined();
    expect(state.calendar.alarms).toHaveLength(1);
  });

  it("sets a calendar alarm with numeric minutes", () => {
    const result = setAlarm(state, {
      clock: "calendar",
      in: 120,
      message: "Sentry rotation",
    });
    expect(result.fires_at).toBe(120);
  });

  it("sets a combat alarm", () => {
    startCombat(state);
    const result = setAlarm(state, {
      clock: "combat",
      in: 10,
      message: "Bridge collapses",
    });
    expect(result.fires_at).toBe(10);
    expect(state.combat.alarms).toHaveLength(1);
  });

  it("sets a repeating alarm", () => {
    startCombat(state);
    setAlarm(state, {
      clock: "combat",
      in: 3,
      message: "Poison damage",
      repeating: 3,
    });
    expect(state.combat.alarms[0].repeating).toBe(3);
  });

  it("rejects non-numeric combat alarm", () => {
    startCombat(state);
    expect(() =>
      setAlarm(state, {
        clock: "combat",
        in: "3 rounds" as unknown as number,
        message: "test",
      }),
    ).toThrow("numeric round count");
  });
});

describe("clearAlarm", () => {
  it("clears an existing alarm", () => {
    const { id } = setAlarm(state, {
      clock: "calendar",
      in: "1 day",
      message: "test",
    });
    const result = clearAlarm(state, id);
    expect(result).not.toBeNull();
    expect(result!.cleared).toBe(id);
    expect(state.calendar.alarms).toHaveLength(0);
  });

  it("returns null for nonexistent alarm", () => {
    expect(clearAlarm(state, "nope")).toBeNull();
  });
});

describe("advanceCalendar", () => {
  it("advances time", () => {
    advanceCalendar(state, 360); // 6 hours
    expect(state.calendar.current).toBe(360);
  });

  it("fires alarms at threshold", () => {
    setAlarm(state, {
      clock: "calendar",
      in: 100,
      message: "Alert!",
    });
    const fired = advanceCalendar(state, 100);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toBe("Alert!");
    // Non-repeating alarm should be removed
    expect(state.calendar.alarms).toHaveLength(0);
  });

  it("fires alarms when past threshold", () => {
    setAlarm(state, {
      clock: "calendar",
      in: 50,
      message: "Alert!",
    });
    const fired = advanceCalendar(state, 100);
    expect(fired).toHaveLength(1);
  });

  it("does not fire alarms before threshold", () => {
    setAlarm(state, {
      clock: "calendar",
      in: 200,
      message: "Not yet",
    });
    const fired = advanceCalendar(state, 100);
    expect(fired).toHaveLength(0);
    expect(state.calendar.alarms).toHaveLength(1);
  });

  it("handles repeating alarms", () => {
    setAlarm(state, {
      clock: "calendar",
      in: 100,
      message: "Patrol",
      repeating: 100,
    });
    const fired1 = advanceCalendar(state, 100);
    expect(fired1).toHaveLength(1);
    // Alarm should still exist, advanced to 200
    expect(state.calendar.alarms).toHaveLength(1);
    expect(state.calendar.alarms[0].fires_at).toBe(200);

    const fired2 = advanceCalendar(state, 100);
    expect(fired2).toHaveLength(1);
    expect(state.calendar.alarms[0].fires_at).toBe(300);
  });

  it("fires multiple alarms in one advance", () => {
    setAlarm(state, { clock: "calendar", in: 50, message: "First" });
    setAlarm(state, { clock: "calendar", in: 80, message: "Second" });
    setAlarm(state, { clock: "calendar", in: 200, message: "Not yet" });

    const fired = advanceCalendar(state, 100);
    expect(fired).toHaveLength(2);
    expect(state.calendar.alarms).toHaveLength(1); // only "Not yet" remains
  });
});

describe("combat rounds", () => {
  beforeEach(() => {
    startCombat(state);
  });

  it("advances rounds", () => {
    const result = nextRound(state);
    expect(result.round).toBe(1);
    expect(state.combat.current).toBe(1);
  });

  it("fires combat alarms", () => {
    setAlarm(state, { clock: "combat", in: 3, message: "Bridge collapses" });
    nextRound(state); // round 1
    nextRound(state); // round 2
    const result = nextRound(state); // round 3
    expect(result.alarms_fired).toHaveLength(1);
    expect(result.alarms_fired[0].message).toBe("Bridge collapses");
  });

  it("handles repeating combat alarms", () => {
    setAlarm(state, {
      clock: "combat",
      in: 2,
      message: "Poison",
      repeating: 2,
    });
    nextRound(state); // round 1 — no fire
    const r2 = nextRound(state); // round 2 — fires
    expect(r2.alarms_fired).toHaveLength(1);
    nextRound(state); // round 3 — no fire
    const r4 = nextRound(state); // round 4 — fires again
    expect(r4.alarms_fired).toHaveLength(1);
  });

  it("rejects nextRound without active combat", () => {
    endCombat(state);
    expect(() => nextRound(state)).toThrow("No active combat");
  });

  it("endCombat resets everything", () => {
    setAlarm(state, { clock: "combat", in: 5, message: "test" });
    nextRound(state);
    nextRound(state);
    const result = endCombat(state);
    expect(result.rounds).toBe(2);
    expect(state.combat.active).toBe(false);
    expect(state.combat.current).toBe(0);
    expect(state.combat.alarms).toHaveLength(0);
  });
});

describe("checkClocks", () => {
  it("reports current state", () => {
    advanceCalendar(state, 480); // 8am day 1
    setAlarm(state, { clock: "calendar", in: "1 day", message: "Tomorrow" });

    const result = checkClocks(state);
    expect(result.calendar.current).toBe("Day 1, morning");
    expect(result.calendar.next_alarm).toBeDefined();
    expect(result.calendar.next_alarm!.message).toBe("Tomorrow");
    expect(result.combat.active).toBe(false);
  });

  it("reports combat state when active", () => {
    startCombat(state);
    nextRound(state);
    setAlarm(state, { clock: "combat", in: 5, message: "Spell expires" });

    const result = checkClocks(state);
    expect(result.combat.active).toBe(true);
    expect(result.combat.round).toBe(1);
    expect(result.combat.next_alarm).toBeDefined();
  });
});
