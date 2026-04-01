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

Tracks combat rounds. Increments each combat round. Scoped to the current combat — resets when combat ends. The DM calls `time({ operation: "next_round" })` when a combat round ends, or the engine increments automatically if combat round structure is formalized.

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

Two consolidated tools cover all clock and alarm operations.

### `alarm` — schedule future events

Operations: `set`, `clear`, `check`.

```
alarm({
  operation: "set",
  clock: "calendar",
  in: "3 days",
  message: "The orc warband reaches Thornfield. See lore/orc-invasion-plan.md"
})
→ "Alarm alarm-017: fires at 14400 (Day 8, morning)"

alarm({
  operation: "set",
  clock: "combat",
  in: 10,
  message: "The bridge collapses. All entities on bridge tiles fall (3d6, DEX DC 14)."
})
→ "Alarm alarm-018: fires at 16"

alarm({
  operation: "set",
  clock: "combat",
  in: 3,
  repeating: 3,
  message: "Poison: Aldric takes 1d4 poison damage (CON save DC 12 to end)."
})
→ "Alarm alarm-019: fires at 9"

alarm({ operation: "clear", id: "alarm-019" })
→ "Alarm alarm-019 cleared"

alarm({ operation: "check" })
→ { calendar: { current: "Day 5, afternoon", next_alarm: { ... } },
     combat: { active: true, round: 9, next_alarm: { ... } } }
```

### `time` — advance narrative or combat time

Operations: `advance`, `next_round`. Both fire any triggered alarms.

```
time({ operation: "advance", minutes: 480 })
→ "Calendar advanced. Alarms fired: The orc warband reaches Thornfield."

time({ operation: "next_round" })
→ "Round 10. Alarms: The bridge collapses."
```

## How Alarms Fire

When a clock ticks (calendar via `scene_transition`, combat via `time` next_round), the engine checks all alarms on that clock:

1. Any alarm where `fires_at <= current` fires
2. The alarm's message is returned in the tool result — it enters the DM's context as part of the current exchange
3. Non-repeating alarms are removed
4. Repeating alarms have their `fires_at` advanced by the repeat interval

Alarm messages are **invisible to the player**. They appear only in the DM's context. The DM decides how and when to narrate the consequences.

## Spell and Effect Duration Tracking

The round counter's biggest win: the DM never has to manually count spell durations. Cast Hold Person → `alarm({ operation: "set", clock: "combat", in: 10, message: "Hold Person on G3 expires." })`. The engine counts. The DM gets notified.

This also works for:
- Concentration tracking (alarm fires → "Concentration check needed or [spell] drops")
- Buff/debuff timers
- Temporary HP expiration
- "You have 3 rounds before the guards arrive"
- Any game-system feature with a round-based duration

## Integration with Existing Systems

**`scene_transition`**: Already accepts `time_advance`. After advancing the calendar clock, it checks alarms and includes any fired alarm messages in its return to the DM. No new design needed.

**Resolution hooks**: Dice roll hooks already fire after every roll. If combat round advancement should be triggered automatically (e.g., after all combatants have acted), a hook can call `time` next_round internally.

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
