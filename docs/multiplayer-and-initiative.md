# Multiplayer and Initiative Design

## Multiplayer: Hot-Seat

Multiplayer is hot-seat only — multiple players share one terminal. No networking, no sync, no authentication. The TUI knows who's active and labels input accordingly.

### TUI Layout

When multiple players are in the session, the bottom of the TUI shows a player bar:

```
┌─────────────────────────────────────┐
│  Narrative scroll area              │
│  "The goblin shrieks and hurls..."  │
│                                     │
├─────────────────────────────────────┤
│  ═══════╡ flourish ╞══════════════  │
├─────────────────────────────────────┤
│  HP: 42/42 | Loc: Goblin Caves L2  │
├─────────────────────────────────────┤
│  > I swing my sword at the goblin  │
├─────────────────────────────────────┤
│  [Aldric]  Sable  Rook(AI)         │
└─────────────────────────────────────┘
```

- Active player is highlighted (brackets, bold, color — TBD)
- AI players are marked with `(AI)`
- Outside of initiative: players switch freely with a hotkey
- During initiative: the initiative system controls who's active

### Player Switching

**Outside initiative:** Any human player can press a hotkey (e.g., Tab) to switch the active player. The modeline updates to show the new active character's status. The DM sees a notification of the switch.

**During initiative:** The TUI automatically activates the player whose turn it is. Human players type their action; AI players act automatically. The player bar shows turn order highlighting.

### Multiple Players in the Agent Loop

From the DM's perspective, multiple players are just multiple characters. The DM's narration goes to everyone (it's one screen). Player inputs are tagged with who said them:

```
User message: "[Aldric] I swing my sword at the goblin"
User message: "[Sable] I cast Shield on Aldric"
```

The DM responds to all active players naturally. Outside of combat, it can address the party as a group or specific characters individually.

## AI Players

An AI player is a model call that replaces human input. When it's an AI player's turn, instead of waiting for TUI input, the engine makes an API call and feeds the response into the agent loop as player input.

### AI Player Context

Minimal. An AI player's prompt is:

```
System: You are Rook, a half-elf rogue with a sardonic streak and a
        pragmatic survival instinct. You don't trust easily. You
        prefer stealth and cleverness over brute force. You are loyal
        to the party but always have an exit planned.

        Respond in character. Say what you do, concisely. You may
        include brief dialogue. Do not narrate outcomes — the DM
        handles that.

Context: [character sheet summary, ~200 tokens]
         [last 3-5 exchanges of DM narration, ~500 tokens]

Input: The DM's latest narration addressed to you or the party.
```

Total input: ~1-2K tokens. Model: Haiku for functional, Sonnet for more personality. Cost per AI turn: effectively free.

### AI Player Behavior

- AI players **respond concisely** — a sentence or two, like a real player at a table
- They **do not narrate outcomes** — "I try to pick the lock" not "I pick the lock and it opens"
- They **stay in character** — their personality prompt drives their decisions
- They **can ask questions** — "Is there another exit?" gets handled by the DM like any player question
- They **participate in player-facing subagents** — if the resolve session asks "use Divine Smite?", the AI player's personality prompt informs the choice (a pragmatic character conserves resources, a reckless one always smites)

### AI Player Configuration

Set during game init or added mid-campaign:

```jsonc
// config.json (partial)
{
  "players": [
    { "name": "Alex", "character": "aldric", "type": "human" },
    { "name": "Rook", "character": "rook", "type": "ai",
      "model": "haiku",
      "personality": "Sardonic, pragmatic, stealth-first. Loyal but always has an exit planned." }
  ]
}
```

### What AI Players Enable

- **Solo with companions** — one human player, 2-3 AI party members. The classic "I want a party but I'm playing alone" solution.
- **Mixed parties** — 2 humans hot-seat, 1-2 AI companions filling out the party.
- **Demo mode** — full AI party. Watch the game play itself. Useful for testing and showcase.
- **Drop-in/drop-out** — a human player leaves, their character becomes AI-controlled. A new human sits down, takes over an AI character.

## Initiative

Initiative tracking manages turn order during combat. It's a Tier 1 (code) system — the DM sets it up, the engine enforces order.

### How It Works

1. **Combat starts.** The DM calls `start_combat` with a list of combatants.
2. **Initiative is rolled.** The engine (or a Haiku subagent, depending on system complexity) rolls initiative for all combatants, reads relevant modifiers from character sheets, and sorts the turn order.
3. **The turn order is set.** The TUI displays it. The player bar highlights whose turn it is.
4. **Turns cycle.** Each combatant acts in order:
   - **Human player's turn:** TUI activates that player's input. They type their action.
   - **AI player's turn:** AI player model call generates the action automatically.
   - **NPC/enemy turn:** The DM narrates their action (silently using the resolve session for mechanics).
5. **Round ends.** `next_round` fires, combat clock ticks, alarms checked.
6. **Combat ends.** The DM calls `end_combat`. Initiative clears. Player switching returns to free mode.

### Tools

**`start_combat`**
```
start_combat({
  combatants: [
    { id: "aldric", type: "pc" },
    { id: "sable", type: "pc" },
    { id: "rook", type: "ai_pc" },
    { id: "G1", type: "npc" },
    { id: "G2", type: "npc" }
  ]
})
→ {
    order: [
      { id: "rook", initiative: 19, type: "ai_pc" },
      { id: "G1", initiative: 17, type: "npc" },
      { id: "aldric", initiative: 14, type: "pc" },
      { id: "sable", initiative: 11, type: "pc" },
      { id: "G2", initiative: 8, type: "npc" }
    ],
    round: 1
  }
```

The initiative roll method depends on the game system:
- D&D: d20 + DEX modifier (code rolls, reads modifier from character sheet)
- Savage Worlds: card draw from initiative deck
- PbtA: no initiative (fiction-first)
- Freeform: DM decides order, or players go first

The `start_combat` tool knows which method to use from the game system config.

**`modify_initiative`**
For mid-combat changes: a character delays, readies an action, or a new combatant joins.

```
modify_initiative({
  action: "add",              // "add" | "remove" | "move" | "delay"
  combatant: "G3",
  position: "after:G1"        // or a specific initiative value
})
```

**`end_combat`**
```
end_combat({})
→ { rounds: 8, combat_clock_reset: true }
```

Clears initiative order, resets the combat round counter, clears combat alarms. Player switching returns to free hotkey mode.

### Initiative Display

During combat, the modeline or a dedicated TUI region shows the turn order:

```
Initiative: Rook(AI) → [G1] → Aldric → Sable → G2  |  Round 3
```

Current turn is highlighted. Dead/unconscious combatants are grayed out or removed. This is a UI tool the DM can also update manually if needed.

### System-Agnostic Design

Initiative is configured during game init based on the selected system:

```jsonc
// config.json (partial)
{
  "combat": {
    "initiative_method": "d20_dex",    // "d20_dex" | "card_draw" | "fiction_first" | "custom"
    "initiative_deck": null,            // deck ID, if card-based
    "round_structure": "individual",    // "individual" | "side" | "popcorn"
    "surprise_rules": true
  }
}
```

For "fiction_first" (PbtA, freeform): no mechanical initiative. The DM decides who acts when. The initiative display is hidden. `start_combat` just activates the combat clock and color scheme change.

For exotic systems, the game init agent can configure or code-generate a custom initiative handler, same as with exotic dice.
