# Randomization Tools Design

Tabletop RPGs use a variety of randomization mechanics beyond simple dice rolls. This system provides a set of primitives that cover the common cases and an extension point for exotic systems.

## Core Principles

- **Randomization is Tier 1 (code).** True randomness, zero tokens. No model is involved in generating random numbers, drawing cards, or shuffling decks.
- **Resolution is Tier 2 (Haiku).** Figuring out *what* to roll — which modifiers apply, what conditions matter — is a subagent job. It reads character sheets and rules, then calls the Tier 1 primitives.
- **Narration is Tier 3 (Opus).** The DM decides what the result *means* in the fiction.
- **Tools return mechanistic results.** `3d10` returns `{ rolls: [1, 6, 3], total: 10 }`, not just `10`. Individual die results are always preserved so the UI can present them however it likes and so downstream logic (crits, exploding dice, success counting) can inspect them.
- **Resource pools live on character sheets**, not in a separate system. Spell slots, ki points, inspiration, HP — these are character attributes. The `resolve_action` subagent reads and updates them as part of resolving actions. Shared party resources live on a party entity file.

## Primitives

### Dice — `roll_dice`

Tier 1, stateless. Accepts standard dice notation with extensions.

```
roll_dice({
  expression: "2d20kh1+5",
  reason: "Aldric longsword attack (advantage)",
  display: true
})
→ {
    expression: "2d20kh1+5",
    rolls: [18, 7],
    kept: [18],
    modifier: 5,
    total: 23,
    reason: "Aldric longsword attack (advantage)"
  }
```

Notation support:
- Basic: `3d6`, `1d20+5`, `2d8-1`
- Keep highest/lowest: `4d6kh3` (stat generation), `2d20kl1` (disadvantage)
- Exploding: `3d6!` (reroll and add on max)
- Success counting: `6d10>=7` (count dice showing 7+; World of Darkness)
- FATE dice: `4dF` (each die is -1, 0, or +1)
- Multiple expressions: `1d20+5; 1d8+3` (attack and damage in one call)

For truly exotic dice (FFG narrative dice with symbols, etc.), game init registers custom roll handlers. The notation parser is extensible.

#### Player-claimed rolls

```
roll_dice({
  expression: "1d20+5",
  reason: "Aldric longsword attack",
  claimed_result: { rolls: [18], total: 23 },
  display: true
})
```

The tool validates the claim is *possible* (a die showing 18 on a d20 is valid). It protests if the claim is impossible ("You can't roll 25 on 1d20+5"). It still fires hooks regardless of who rolled — the turn counter doesn't care who threw the dice.

### Cards — `deck`

Tier 1, stateful. A deck has an order, a draw pile, a discard pile, and optionally hands.

```
deck({
  deck: "initiative-deck",
  operation: "draw",
  count: 1,
  from: "top"                   // "top" | "random" | "bottom"
})
→ { cards: [{ value: "Jack", suit: "Spades", raw: "JS" }], remaining: 47 }
```

Operations:
- `create` — initialize a new deck (standard 52-card, tarot, or custom card list)
- `shuffle` — randomize the draw pile, optionally folding in the discard pile
- `draw` — pull cards from the draw pile
- `return` — put specific cards back (to draw pile or discard)
- `peek` — look at the top N cards without drawing
- `state` — return the full deck state (for DM inspection)

Deck state is persisted to `state/decks/<name>.json` in the campaign directory. Decks are created during game init if the system uses them.

### Random Tables

Random tables are **not** a Tier 1 primitive. They are a Tier 2 (Haiku) task.

Real-world random tables in RPG sourcebooks are rarely simple lookups. They cascade ("roll on Sub-Table C"), have conditionals ("if party is level 5+, add one creature from Column B"), cross-reference other rules ("modified by current terrain type, see p.47"), and sometimes require judgment. Encoding all of this into a JSON schema would mean building a rules engine. Instead:

1. Random tables stay as **markdown in the rules files**, exactly as they appear in the source material.
2. The DM (or a Haiku subagent) calls `roll_dice` to get the raw roll.
3. The subagent reads the table text, interprets the result, follows cross-references, chains sub-rolls as needed, and returns the final outcome.

This is the same pattern as `resolve_action`: Tier 1 rolls the dice, Tier 2 reads and reasons, Tier 3 narrates. No special table format, no `state/tables/` directory, no lookup engine. Haiku just reads the page.

## Resolution Subagent — `resolve_action`

Tier 2 (Haiku). The tool the DM calls most often. It wraps all mechanical reasoning.

```
resolve_action({
  actor: "aldric",
  action: "attack with longsword",
  target: "G1",
  conditions: ["target is prone", "dim light"]
})
→ {
    summary: "Hit. 10 slashing damage.",
    rolls: [
      { expression: "2d20kh1+5", rolls: [18, 7], kept: [18], modifier: 5, total: 23,
        reason: "attack roll (advantage: target prone)" },
      { expression: "1d8+3", rolls: [7], modifier: 3, total: 10,
        reason: "longsword damage" }
    ],
    against: { stat: "AC", value: 13 },
    details: "Advantage from prone target. No penalty from dim light (paladin has no ranged component). Longsword, one-handed (shield equipped).",
    state_changes: []
  }
```

The subagent:
1. Reads the actor's character sheet and the target's stats
2. Reads relevant rules for the action type
3. Determines applicable modifiers from conditions, equipment, and abilities
4. Calls `roll_dice` (Tier 1) with the computed expression
5. Evaluates the result against the target number
6. Computes any state changes (HP reduction, resource expenditure, condition application)
7. Returns the full breakdown to the DM

The DM gets a structured result and narrates: "Aldric's blade catches the goblin across the throat..."

### Token optimization for resolution

Combat is bursty — many `resolve_action` calls in a short window, all needing the same rules context. Two optimizations keep costs down:

**Prompt caching.** The Claude API caches repeated prompt prefixes at ~10% of normal input token cost. The resolution subagent's system prompt (including rules text) is the same across all calls in a combat encounter. The first call pays full price; every subsequent call hits the cache. This is nearly free to implement — just front-load the rules into the subagent's system prompt and the API handles the rest.

**Distilled rule cards.** During game initialization, a Haiku subagent reads the full combat rules and produces a dense reference card — a compressed cheat sheet optimized for mechanical resolution, not human readability. Example:

```markdown
## Melee Attack
d20 + STR mod + prof (finesse: DEX or STR). ≥ target AC = hit.
Nat 20: crit, double damage dice. Nat 1: auto miss.
Advantage: 2d20kh1. Disadvantage: 2d20kl1.
```

The full rules stay on disk as the source of truth. The distilled card is what gets loaded into the subagent context for routine resolution. This can cut the rules payload by 60-80% for a crunchy system like 5e.

Together, these two optimizations reduce combat resolution token costs by an estimated 80-90% compared to naively loading full rules on every call.

### Player-facing resolution

When the resolution subagent needs player input (e.g., "Do you want to use your Divine Smite on this hit?"), it operates as a player-facing subagent — temporarily taking over the TUI to ask the question, then resuming. This keeps the DM out of mechanical negotiations.

### NPC resolution

NPCs use the same subagent, but silently. The DM calls `resolve_action` for an NPC attack; the subagent resolves it and returns the result without showing anything to the player. The DM narrates whatever it wants the player to see.

## Hooks

Every randomization event can trigger hooks — Tier 1 code that runs automatically after a roll/draw/etc.

- **Turn counter**: advance by the configured amount for this event type
- **Transcript logging**: append a mechanistic record to the scene transcript
- **Alarm check**: did any turn-counter alarms fire from the advance?
- **Custom hooks**: game init can register system-specific hooks (e.g., "on a natural 1, roll on the critical fumble table"; "on a Joker in initiative, the character gets a bonus action")

Hooks fire regardless of whether the roll was system-generated or player-claimed.

## Exotic Systems and Code Generation

Some game systems have randomization mechanics that can't be expressed in standard dice notation:
- FFG Star Wars / Genesys: proprietary dice with symbols (Success, Advantage, Triumph, etc.)
- Dread: Jenga tower (would need probabilistic simulation)
- Some PbtA games: highly structured "moves" with specific trigger conditions
- Coin flips, drawing from a bag, bidding systems

During game initialization, the setup agent can:
1. Identify non-standard mechanics in the source materials
2. Code-generate custom roll handlers in TypeScript
3. Register them as available tool extensions

The architecture supports this through an extensible tool registry — custom handlers plug into the same interface as the built-in dice/card primitives, so `resolve_action` can use them without special-casing.

## State on Disk

```
campaign-root/
├── state/
│   └── decks/
│       ├── initiative-deck.json
│       └── deck-of-many-things.json
```

Decks are the only randomization primitive with persistent state (draw order, discard pile, hands). Dice are stateless. Random tables live as markdown in the rules files — no structured format needed. Resource pools live on character sheets.

## The Party Entity

Shared resources that don't belong to any individual character live on a party entity file:

```markdown
# The Party

**Members:** [Aldric](characters/aldric.md), [Sable](characters/sable.md)
**Location:** [Goblin Caves, Level 2](locations/goblin-caves/index.md)

## Shared Resources
- Group luck tokens: 2
- Party gold: 340
- Rations: 8 days

## Changelog
- **Scene 010**: Found 200 gold in the goblin hoard. Aldric kept the [Staff of Echoes](lore/staff-of-echoes.md), rest split evenly.
- **Scene 012**: Spent 1 luck token to avoid TPK in the cave-in.
```

This lives at `characters/party.md` — it's just another character file. The DM reads and updates it like any other entity.
