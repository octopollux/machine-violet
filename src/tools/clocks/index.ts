import type {
  Alarm,
  ClocksState,
  SetAlarmInput,
  SetAlarmOutput,
  AlarmFired,
  NextRoundOutput,
  CheckClocksOutput,
} from "../../types/clocks.js";

/** Create a fresh clocks state */
export function createClocksState(
  epoch = "campaign start",
  displayFormat = "day+time",
): ClocksState {
  return {
    calendar: {
      current: 0,
      alarms: [],
      epoch,
      display_format: displayFormat,
    },
    combat: {
      current: 0,
      alarms: [],
      active: false,
    },
  };
}

/** Parse a time string like "3 days" or "6 hours" into minutes */
export function parseTimeString(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(minutes?|hours?|days?|weeks?)$/i);
  if (!match) {
    throw new Error(`Cannot parse time string: "${input}"`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith("minute")) return Math.round(value);
  if (unit.startsWith("hour")) return Math.round(value * 60);
  if (unit.startsWith("day")) return Math.round(value * 60 * 24);
  if (unit.startsWith("week")) return Math.round(value * 60 * 24 * 7);

  throw new Error(`Unknown time unit: ${unit}`);
}

/** Format a minutes-since-epoch value for display */
export function formatCalendarTime(
  minutes: number,
  format: string,
): string {
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);

  if (format === "day+time") {
    const timeOfDay = getTimeOfDay(hours);
    return `Day ${days + 1}, ${timeOfDay}`;
  }

  if (format === "abstract") {
    return `Turn ${Math.floor(minutes)}`;
  }

  // Default fallback
  return `Day ${days + 1}, ${hours.toString().padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
}

function getTimeOfDay(hour: number): string {
  if (hour < 5) return "night";
  if (hour < 8) return "dawn";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 17) return "afternoon";
  if (hour < 20) return "evening";
  return "night";
}

let alarmCounter = 0;

/** Reset alarm counter (for testing) */
export function resetAlarmCounter(): void {
  alarmCounter = 0;
}

/** Set an alarm on either clock */
export function setAlarm(
  state: ClocksState,
  input: SetAlarmInput,
): SetAlarmOutput {
  const clock = state[input.clock];
  const id = `alarm-${String(++alarmCounter).padStart(3, "0")}`;

  let firesAt: number;
  if (input.clock === "combat") {
    if (typeof input.in !== "number") {
      throw new Error("Combat alarms require a numeric round count");
    }
    firesAt = clock.current + input.in;
  } else {
    if (typeof input.in === "number") {
      firesAt = clock.current + input.in;
    } else {
      firesAt = clock.current + parseTimeString(input.in);
    }
  }

  const alarm: Alarm = {
    id,
    fires_at: firesAt,
    message: input.message,
  };

  if (input.repeating) {
    alarm.repeating = input.repeating;
  }

  clock.alarms.push(alarm);

  const output: SetAlarmOutput = { id, fires_at: firesAt };
  if (input.clock === "calendar") {
    output.display = formatCalendarTime(firesAt, state.calendar.display_format);
  }

  return output;
}

/** Clear an alarm by ID from either clock */
export function clearAlarm(
  state: ClocksState,
  id: string,
): { cleared: string; was: string } | null {
  for (const clockKey of ["calendar", "combat"] as const) {
    const clock = state[clockKey];
    const idx = clock.alarms.findIndex((a) => a.id === id);
    if (idx !== -1) {
      const removed = clock.alarms.splice(idx, 1)[0];
      return { cleared: id, was: removed.message };
    }
  }
  return null;
}

/** Advance the calendar clock and fire any triggered alarms */
export function advanceCalendar(
  state: ClocksState,
  minutes: number,
): AlarmFired[] {
  state.calendar.current += minutes;
  return fireAlarms(state.calendar);
}

/** Advance to the next combat round and fire any triggered alarms */
export function nextRound(state: ClocksState): NextRoundOutput {
  if (!state.combat.active) {
    throw new Error("No active combat");
  }
  state.combat.current++;
  const fired = fireAlarms(state.combat);
  return { round: state.combat.current, alarms_fired: fired };
}

/** Start combat */
export function startCombat(state: ClocksState): void {
  state.combat.active = true;
  state.combat.current = 0;
  state.combat.alarms = [];
}

/** End combat — reset round counter and clear combat alarms */
export function endCombat(state: ClocksState): { rounds: number } {
  const rounds = state.combat.current;
  state.combat.active = false;
  state.combat.current = 0;
  state.combat.alarms = [];
  return { rounds };
}

/** Check current state of both clocks */
export function checkClocks(state: ClocksState): CheckClocksOutput {
  const calendarDisplay = formatCalendarTime(
    state.calendar.current,
    state.calendar.display_format,
  );

  const nextCalendarAlarm = state.calendar.alarms
    .filter((a) => a.fires_at > state.calendar.current)
    .sort((a, b) => a.fires_at - b.fires_at)[0];

  const nextCombatAlarm = state.combat.alarms
    .filter((a) => a.fires_at > state.combat.current)
    .sort((a, b) => a.fires_at - b.fires_at)[0];

  return {
    calendar: {
      current: calendarDisplay,
      next_alarm: nextCalendarAlarm
        ? {
            id: nextCalendarAlarm.id,
            fires: formatCalendarTime(
              nextCalendarAlarm.fires_at,
              state.calendar.display_format,
            ),
            message: nextCalendarAlarm.message,
          }
        : undefined,
    },
    combat: {
      active: state.combat.active,
      round: state.combat.current,
      next_alarm: nextCombatAlarm
        ? {
            id: nextCombatAlarm.id,
            fires: `Round ${nextCombatAlarm.fires_at}`,
            message: nextCombatAlarm.message,
          }
        : undefined,
    },
  };
}

/** Fire all alarms whose fire_at <= current, handle repeating */
function fireAlarms(clock: { current: number; alarms: Alarm[] }): AlarmFired[] {
  const fired: AlarmFired[] = [];
  const toRemove: number[] = [];

  for (let i = 0; i < clock.alarms.length; i++) {
    const alarm = clock.alarms[i];
    if (alarm.fires_at <= clock.current) {
      fired.push({ id: alarm.id, message: alarm.message });
      if (alarm.repeating) {
        alarm.fires_at += alarm.repeating;
      } else {
        toRemove.push(i);
      }
    }
  }

  // Remove non-repeating fired alarms (reverse order to preserve indices)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    clock.alarms.splice(toRemove[i], 1);
  }

  return fired;
}
