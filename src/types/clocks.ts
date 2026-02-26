export interface Alarm {
  id: string;
  fires_at: number;
  message: string;
  repeating?: number;
}

export interface Clock {
  current: number;
  alarms: Alarm[];
}

export interface CalendarClock extends Clock {
  epoch: string;
  display_format: string;
}

export interface CombatClock extends Clock {
  active: boolean;
}

export interface ClocksState {
  calendar: CalendarClock;
  combat: CombatClock;
}

export interface SetAlarmInput {
  clock: "calendar" | "combat";
  in: number | string; // number for combat rounds, string like "3 days" for calendar
  message: string;
  repeating?: number;
}

export interface SetAlarmOutput {
  id: string;
  fires_at: number;
  display?: string;
}

export interface AlarmFired {
  id: string;
  message: string;
}

export interface NextRoundOutput {
  round: number;
  alarms_fired: AlarmFired[];
}

export interface CheckClocksOutput {
  calendar: {
    current: string;
    next_alarm?: { id: string; fires: string; message: string };
  };
  combat: {
    active: boolean;
    round: number;
    next_alarm?: { id: string; fires: string; message: string };
  };
}
