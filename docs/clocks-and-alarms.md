# Clocks and Alarms Design

The DM manages a living world without manually tracking time or counting rounds. Two clocks — one for narrative time, one for tactical time — tick automatically and fire alarms when thresholds are reached. Pure Tier 1 code, zero tokens.

## Two Clocks

### Calendar (narrative time)

Tracks in-game date and time. Measured in minutes internally, displayed as human-readable ("Day 5, afternoon"). Advances via `scene_transition`'s `time_advance` parameter — the DM says "6 hours pass" and the engine handles the math.

Use cases:
- "The orc warband arrives in 3 days"
- "The merchant caravan departs at dawn"
- "The plague reaches the next village in a week"
- "The ritual must be completed before the new moon"
- Sentry rotations, shop schedules, NPC daily routines

### Round counter (tactical time)

Tracks combat rounds. Increments each combat round. Scoped to the current combat — resets when combat ends. The DM calls `next_round()` when a combat round ends, or the engine increments automatically if combat round structure is formalized.

Use cases:
- "The bridge collapses in 10 rounds"
- "Hold Person expires in 6 rounds"
- "Poison: 1d4 damage every 3 rounds"
- Concentration duration tracking
- Environmental hazard timers ("the room floods in 5 rounds")
- Buff/debuff expiration

## Data Model

```typescript
interface Clock {
  current: number;
  alarms: Alarm[];
}

interface Alarm {
  id: string;
  fires_at: number;
  message: string;          // injected into DM context when it fires
  repeating?: number;       // fires every N ticks (sentry rotation, recurring damage)
}
```

Both clocks use the same structure. The only difference is what ticks them and when they reset.

## Tools

### `set_alarm`

The DM sets alarms on either clock.

```
set_alarm({
  clock: "calendar",
  in: "3 days",
  message: "The orc warband reaches Thornfield. See lore/orc-invasion-plan.md"
})
→ { id: "alarm-017", fires_at: 14400, display: "Day 8, morning" }

set_alarm({
  clock: "combat",
  in: 10,
  message: "The bridge collapses. All entities on bridge tiles fall (3d6, DEX DC 14)."
})
→ { id: "alarm-018", fires_at: 16 }

set_alarm({
  clock: "combat",
  in: 3,
  repeating: 3,
  message: "Poison: Aldric takes 1d4 poison damage (CON save DC 12 to end)."
})
→ { id: "alarm-019", fires_at: 9, repeats_every: 3 }
```

### `clear_alarm`

Remove an alarm by ID (spell ended early, threat neutralized).

```
clear_alarm({ id: "alarm-019" })
→ { cleared: "alarm-019", was: "Poison: Aldric takes 1d4 poison damage..." }
```

### `next_round`

Advance the combat round counter. Check and fire any combat alarms.

```
next_round({})
→ {
    round: 10,
    alarms_fired: [
      { id: "alarm-018", message: "The bridge collapses. All entities on bridge tiles fall (3d6, DEX DC 14)." }
    ]
  }
```

### `check_clocks`

Read current state of both clocks and pending alarms. For DM situational awareness.

```
check_clocks({})
→ {
    calendar: {
      current: "Day 5, afternoon",
      next_alarm: { id: "orc-arrival", fires: "Day 8, morning", message: "..." }
    },
    combat: {
      active: true,
      round: 9,
      next_alarm: { id: "bridge-collapse", fires: "Round 10", message: "..." }
    }
  }
```

## How Alarms Fire

When a clock ticks (calendar via `scene_transition`, combat via `next_round`), the engine checks all alarms on that clock:

1. Any alarm where `fires_at <= current` fires
2. The alarm's message is returned in the tool result — it enters the DM's context as part of the current exchange
3. Non-repeating alarms are removed
4. Repeating alarms have their `fires_at` advanced by the repeat interval

Alarm messages are **invisible to the player**. They appear only in the DM's context. The DM decides how and when to narrate the consequences.

## Spell and Effect Duration Tracking

The round counter's biggest win: the DM never has to manually count spell durations. Cast Hold Person → `set_alarm({ clock: "combat", in: 10, message: "Hold Person on G3 expires." })`. The engine counts. The DM gets notified.

This also works for:
- Concentration tracking (alarm fires → "Concentration check needed or [spell] drops")
- Buff/debuff timers
- Temporary HP expiration
- "You have 3 rounds before the guards arrive"
- Any game-system feature with a round-based duration

## Integration with Existing Systems

**`scene_transition`**: Already accepts `time_advance`. After advancing the calendar clock, it checks alarms and includes any fired alarm messages in its return to the DM. No new design needed.

**Resolution hooks**: Dice roll hooks already fire after every roll. If combat round advancement should be triggered automatically (e.g., after all combatants have acted), a hook can call `next_round` internally.

**Context management**: Alarm notifications are part of tool results, so they follow the standard retention and stubbing policy. An alarm that fired 3 turns ago becomes a one-line stub. The DM already acted on it.

**Scene precis**: When alarms fire, the precis update should note them ("R10: bridge collapsed, G2 fell").

## State on Disk

```jsonc
// state/clocks.json
{
  "calendar": {
    "current": 7200,
    "epoch": "campaign start",
    "display_format": "day+time",
    "alarms": [
      {
        "id": "orc-arrival",
        "fires_at": 10080,
        "message": "The orc warband reaches Thornfield. See lore/orc-invasion-plan.md"
      },
      {
        "id": "sentry-rotation",
        "fires_at": 7440,
        "repeating": 240,
        "message": "Goblin cave sentries rotate. New guards are alert."
      }
    ]
  },
  "combat": {
    "active": false,
    "current": 0,
    "alarms": []
  }
}
```

When combat ends, the combat clock is reset: `active` set to `false`, `current` set to `0`, all combat alarms cleared. The calendar continues ticking.

## Calendar Display Conventions

The calendar doesn't assume a real-world calendar. The display format is configurable during game init:

- Fantasy: "Day 5, afternoon" or "3rd of Harvest Moon, evening"
- Sci-fi: "Stardate 47634.2"
- Abstract: "Turn 47" (for games without a specific time scale)

The internal representation is always minutes-since-epoch. The display format is a formatting function set during game initialization — potentially code-generated for exotic calendar systems.
