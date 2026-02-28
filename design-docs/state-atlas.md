# State Atlas

Single source of truth for runtime state design: types, ownership, persistence, invariants, and lifecycle.

Cross-references: [tools-catalog.md](tools-catalog.md), [subagents-catalog.md](subagents-catalog.md), [context-management.md](context-management.md), [entity-filesystem.md](entity-filesystem.md).

---

## 1. State Schema Tree

### GameState (`src/agents/game-state.ts`)

The single mutable source of truth during a session. Passed to every tool handler.

```
GameState
├── maps: Record<string, MapData>          mut   → state/maps.json       DM via tools
│   └── MapData
│       ├── id: string                     const (set on create)
│       ├── gridType: "square" | "hex"     const
│       ├── bounds: { width, height }      const
│       ├── defaultTerrain: string         const
│       ├── regions: MapRegion[]           mut   (define_region, set_terrain)
│       ├── terrain: Record<coord, string> mut   (set_terrain)
│       ├── entities: Record<coord, MapEntity[]> mut (place/move/remove_entity)
│       ├── annotations: Record<coord, string>   mut (annotate)
│       ├── links: MapLink[]               mut
│       └── meta: Record<string, string>   mut
│
├── clocks: ClocksState                    mut   → state/clocks.json     Engine + DM
│   ├── calendar: CalendarClock
│   │   ├── current: number (minutes)      mut   (advance_calendar, scene_transition)
│   │   ├── alarms: Alarm[]                mut   (set_alarm, clear_alarm, fireAlarms)
│   │   ├── epoch: string                  const (set at campaign init)
│   │   └── display_format: string         const
│   └── combat: CombatClock
│       ├── current: number (rounds)       mut   (next_round)
│       ├── alarms: Alarm[]                mut   (set_alarm, clear_alarm, fireAlarms)
│       └── active: boolean                mut   (start_combat ↔ end_combat)
│
├── combat: CombatState                    mut   → state/combat.json     DM via tools
│   ├── active: boolean                    mut   (start_combat ↔ end_combat)
│   ├── order: InitiativeEntry[]           mut   (start_combat, modify_initiative)
│   ├── round: number                      mut   (start_combat, advance_turn)
│   └── currentTurn: number                mut   (advance_turn, modify_initiative)
│
├── combatConfig: CombatConfig             const → config.json            Campaign init
│   ├── initiative_method: InitiativeMethod
│   ├── initiative_deck?: string
│   ├── round_structure: RoundStructure
│   └── surprise_rules: boolean
│
├── decks: DecksState                      mut   → state/decks.json      DM via tools
│   └── decks: Record<string, DeckState>
│       └── DeckState
│           ├── id: string                 const
│           ├── drawPile: Card[]           mut   (draw, shuffle, create)
│           ├── discardPile: Card[]        mut   (return, shuffle)
│           ├── hands: Record<string, Card[]> mut (draw, return)
│           └── template: string           const
│
├── config: CampaignConfig                 const → config.json            Campaign init
│   ├── version?: number                   const (CAMPAIGN_FORMAT_VERSION at creation)
│   ├── createdAt?: string                 const (ISO 8601 timestamp at creation)
│   ├── name, system, genre, mood, difficulty, premise
│   ├── dm_personality: DMPersonality
│   ├── players: PlayerConfig[]
│   ├── combat: CombatConfig
│   ├── context: ContextConfig
│   ├── recovery: RecoveryConfig
│   ├── choices: ChoicesConfig
│   └── calendar_display_format?: string
│
├── campaignRoot: string                   const                          Session init
└── activePlayerIndex: number              mut   → state/scene.json      DM (switch_player)
```

### Shadow State (alongside GameState, not inside it)

#### SceneState (`src/agents/scene-manager.ts`)

Managed by `SceneManager`. Not passed to tool handlers. Persisted selectively via `StatePersister.persistScene()`.

```
SceneState
├── sceneNumber: number                    mut   (incremented at transition)
├── slug: string                           mut   (reset at transition)
├── transcript: string[]                   mut   (appendTranscript)
├── precis: string                         mut   → state/scene.json     Precis updater
├── openThreads: string                    mut   → state/scene.json     Precis updater
├── npcIntents: string                     mut   → state/scene.json     Precis updater
├── playerReads: PlayerRead[]              mut   → state/scene.json     Precis updater
└── sessionNumber: number                  mut   (incremented at session end)
```

#### DMSessionState (`src/agents/dm-prompt.ts`)

Transient per-session state used to build the cached prefix. Not persisted directly — reconstructed from campaign files on session resume.

```
DMSessionState
├── rulesAppendix?: string                 Loaded from rules/ at session start
├── campaignSummary?: string               Loaded from campaign/log.md
├── sessionRecap?: string                  Loaded from session-recaps/
├── activeState?: string                   Built from PC summaries + alarms + turn holder
├── scenePrecis?: string                   Built from SceneState.precis + threads + intents
├── scenePacing?: string                   Built from exchange count + thread count
├── playerRead?: string                    Synthesized from SceneState.playerReads
└── uiState?: string                       Built from modelines + style info
```

#### Conversation (`src/context/conversation.ts`)

Managed by `ConversationManager`. Persisted to `state/conversation.json`.

```
ConversationManager
├── exchanges: ConversationExchange[]      mut   → state/conversation.json
│   └── ConversationExchange
│       ├── user: MessageParam
│       ├── assistant: MessageParam
│       ├── toolResults: MessageParam[]
│       ├── estimatedTokens: number
│       └── stubbed: boolean
└── config: ContextConfig                  const (from CampaignConfig)
```

#### UI State (`src/context/state-persistence.ts`)

```
PersistedUIState                                  → state/ui.json
├── themeName: string                             Theme asset name (e.g. "gothic")
├── keyColor?: string                             Optional hex key color for swatch hue shift
├── styleName: string                             Legacy, for set_ui_style compat
├── variant: StyleVariant
└── modelines?: Record<string, string>
```

---

## 2. Persistence Map

All state files live under `<campaignRoot>/state/`.

| File | Type | Written by | On |
|------|------|-----------|-----|
| `state/combat.json` | `CombatState` | `StatePersister.persistCombat` | After any tool in `TOOL_STATE_MAP` with `"combat"` |
| `state/clocks.json` | `ClocksState` | `StatePersister.persistClocks` | After any tool with `"clocks"` |
| `state/maps.json` | `Record<string, MapData>` | `StatePersister.persistMaps` | After any tool with `"maps"` |
| `state/decks.json` | `DecksState` | `StatePersister.persistDecks` | After any tool with `"decks"` |
| `state/scene.json` | `PersistedSceneState` | `StatePersister.persistScene` | After precis update, scene transition |
| `state/conversation.json` | `SerializedExchange[]` | `StatePersister.persistConversation` | After each exchange |
| `state/ui.json` | `PersistedUIState` | `StatePersister.persistUI` | After theme/style/modeline changes |
| `config.json` | `CampaignConfig` | `buildCampaignConfig` / `createDefaultCampaignConfig` | Campaign creation only. Read-only during play. Includes `version` (`CAMPAIGN_FORMAT_VERSION`) and `createdAt` (ISO 8601) manifest fields. |
| `pending-operation.json` | `PendingOperation` | `SceneManager` | During scene transition cascade steps |

`StatePersister` uses write-through: each `persist*` call is fire-and-forget with error swallowing. Recovery on next session load reads `loadAll()` and hydrates `GameState`.

---

## 3. Tool x State Access Matrix

Legend: **R** = reads, **W** = writes (triggers persistence), **UI** = returns TUI command, **E** = returns engine command.

### Dice

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `roll_dice` | | | | | | | Stateless. Uses RNG only. |

### Cards

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `deck` | | | | **W** | | | All 6 deck operations mutate DecksState. |

### Map Queries

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `view_area` | R | | | | | | |
| `distance` | R | | | | | | |
| `path_between` | R | | | | | | |
| `line_of_sight` | R | | | | | | |
| `tiles_in_range` | R | | | | | | |
| `find_nearest` | R | | | | | | |

### Map Mutations

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `create_map` | **W** | | | | | | Creates new entry in `state.maps`. |
| `place_entity` | **W** | | | | | | |
| `move_entity` | **W** | | | | | | |
| `remove_entity` | **W** | | | | | | |
| `set_terrain` | **W** | | | | | | Single coord or region. |
| `define_region` | **W** | | | | | | |
| `annotate` | **W** | | | | | | |
| `import_entities` | **W** | | | | | | Batch place. |

### Clocks

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `set_alarm` | | **W** | | | | | Calendar or combat clock. |
| `clear_alarm` | | **W** | | | | | Searches both clocks. |
| `advance_calendar` | | **W** | | | | | Fires triggered alarms. |
| `next_round` | | **W** | | | | | Throws if combat not active. |
| `check_clocks` | | R | | | | | Read-only status of both clocks. |

### Combat

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `start_combat` | | **W** | **W** | | R | | Reads combatConfig. Activates both combat + clocks. |
| `end_combat` | | **W** | **W** | | | | Resets both combat state + combat clock. |
| `advance_turn` | | | **W** | | | | |
| `modify_initiative` | | | **W** | | R | | Reads combatConfig for add action. |

### TUI

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `update_modeline` | | | | | R | R | Reads config.players + activePlayerIndex for default character. Returns **UI**. |
| `set_theme` | | | | | | | Returns **UI**. |
| `set_ui_style` | | | | | | | Returns **UI**. |
| `set_display_resources` | | | | | | | Returns **UI**. |
| `present_choices` | | | | | | | Returns **UI**. |
| `present_roll` | | | | | | | Returns **UI**. |
| `show_character_sheet` | | | | | | | Returns **UI**. |

### Player Management

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `switch_player` | | | | | R | **W** | Searches config.players by name. |

### Scene/Session

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `scene_transition` | | | | | | | Returns **E**. Full cascade handled by SceneManager. |
| `session_end` | | | | | | | Returns **E**. |
| `context_refresh` | | | | | | | Returns **E**. |

### Entity (Worldbuilding)

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `create_entity` | | | | | R | | Reads campaignRoot for paths. Returns **E** (file write). |
| `update_entity` | | | | | R | | Same. |

### OOC / Mode

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `enter_ooc` | | | | | | | Returns **E**. |

### Recovery

| Tool | maps | clocks | combat | decks | config | activePlayerIndex | Notes |
|------|------|--------|--------|-------|--------|-------------------|-------|
| `rollback` | | | | | | | Returns **E**. Git-based. |
| `validate` | | | | | | | Returns **E**. Reads maps + clocks via validator. |

### TOOL_STATE_MAP (`src/agents/tool-registry.ts:989`)

Tools listed here trigger `onStateChanged` → `StatePersister` after successful dispatch:

```
start_combat    → ["combat", "clocks"]
end_combat      → ["combat", "clocks"]
advance_turn    → ["combat"]
modify_initiative → ["combat"]
set_alarm       → ["clocks"]
clear_alarm     → ["clocks"]
advance_calendar → ["clocks"]
next_round      → ["clocks"]
create_map      → ["maps"]
place_entity    → ["maps"]
move_entity     → ["maps"]
remove_entity   → ["maps"]
set_terrain     → ["maps"]
annotate        → ["maps"]
import_entities → ["maps"]
define_region   → ["maps"]
deck            → ["decks"]
switch_player   → []  (empty — activePlayerIndex persisted via scene state)
```

Tools not in this map (`roll_dice`, all TUI tools, scene/session tools, entity tools, OOC, recovery) do not trigger automatic state persistence. TUI tools and scene/session tools return commands that the agent loop handles separately.

---

## 4. Agent Visibility Matrix

| Agent | Model | Sees GameState? | Gets state via | Can mutate? |
|-------|-------|-----------------|----------------|-------------|
| **DM** | Opus | Full reference via tools | Tool dispatch through `ToolRegistry` | Yes (via tools only) |
| **Precis updater** | Haiku | No | Dropped exchange text, current precis, open threads, NPC intents, PC identity string | No |
| **Scene summarizer** | Haiku | No | Scene transcript text | No |
| **Changelog updater** | Haiku | No | Scene transcript + entity filenames list | No |
| **Resolution (resolve_action)** | Haiku | No | Actor/target character sheets, rules cards, conditions | No (but calls `roll_dice`) |
| **Choice generator** | Haiku | No | Last 3-5 exchanges of DM narration | No |
| **AI player** | Haiku/Sonnet | No | Character sheet + personality + last 3-5 exchanges | No |
| **OOC mode** | Sonnet | No | DM's cached prefix + conversation, campaign filesystem (sandboxed read) | No (rollback, config changes) |
| **Character promotion** | Haiku | No | Game rules, existing character file, DM context hint | No (writes entity file via engine) |
| **Dev mode** | Sonnet | No | State inspection tools (`inspect_state`, `mutate_state`), file read/write | Yes (direct mutation via dev tools) |

Key isolation properties:
- **No subagent receives `GameState` directly.** The DM is the sole holder.
- **Subagent context windows are independent.** The DM's context is never polluted by subagent work.
- **File I/O is the bridge.** Subagents that need world data read entity files; those that produce results write files or return text to the DM.

---

## 5. Invariants Catalog

### Combat

| Rule | Guard | Severity |
|------|-------|----------|
| Cannot start combat when already active | `startCombat()` — `if (state.active) throw` | Hard |
| Cannot start combat with zero combatants | `startCombat()` — `if (input.combatants.length === 0) throw` | Hard |
| Cannot end combat when not active | `endCombat()` — `if (!state.active) throw` | Hard |
| Cannot advance turn when not active | `advanceTurn()` — `if (!state.active) throw` | Hard |
| Cannot advance turn with empty order | `advanceTurn()` — `if (state.order.length === 0) throw` | Hard |
| Cannot modify initiative when not active | `modifyInitiative()` — `if (!state.active) throw` | Hard |
| Cannot add duplicate combatant | `addCombatant()` — `if (existing) throw` | Hard |
| Only current combatant can delay | `delayCombatant()` — `if (idx !== state.currentTurn) throw` | Hard |
| `currentTurn` stays in bounds after remove/add/move | Adjustment logic in each modify helper | Hard (implicit) |

*Source: `src/tools/combat/index.ts`*

### Clocks

| Rule | Guard | Severity |
|------|-------|----------|
| Cannot advance combat round when combat not active | `nextRound()` — `if (!state.combat.active) throw` | Hard |
| Combat alarms require numeric round count | `setAlarm()` — `if (typeof input.in !== "number") throw` | Hard |
| Calendar time string must match pattern `N unit` | `parseTimeString()` — regex match or throw | Hard |
| Calendar time must be non-negative | `validateClocks()` — `if (current < 0)` | Soft (validation warning) |
| Alarms should fire in the future | `validateClocks()` — `if (fires_at <= current)` | Soft (validation warning) |

*Source: `src/tools/clocks/index.ts`, `src/tools/filesystem/validation.ts`*

### Decks

| Rule | Guard | Severity |
|------|-------|----------|
| Deck must exist for non-create operations | `requireDeck()` — `if (!deckState) throw` | Hard |
| Cannot draw more cards than remaining | `drawCards()` — `if (count > drawPile.length) throw` | Hard |
| Cannot peek more cards than remaining | `peekCards()` — `if (count > drawPile.length) throw` | Hard |
| Custom deck requires cards | `createDeck()` — `if (!customCards \|\| length === 0) throw` | Hard |
| Return operation requires cards list | `returnCards()` — `if (!input.cards \|\| length === 0) throw` | Hard |
| Returned card must exist somewhere | `returnCards()` — `if (!found) throw` | Hard |

*Source: `src/tools/cards/index.ts`*

### Dice

| Rule | Guard | Severity |
|------|-------|----------|
| Claimed roll count must match expression | `validateClaim()` — `if (rolls.length !== expr.count) throw` | Hard |
| Claimed total must match computed total | `validateClaim()` — `if (claim.total !== expectedTotal) throw` | Hard |
| Die values must be in valid range | `validateClaim()` — `if (roll < 1 \|\| roll > sides) throw` | Hard |
| FATE die values must be -1, 0, or +1 | `validateClaim()` — `if (roll < -1 \|\| roll > 1) throw` | Hard |
| Claimed results only for single expressions | `validateClaim()` — `if (expressions.length !== 1) throw` | Hard |

*Source: `src/tools/dice/index.ts`*

### Maps

| Rule | Guard | Severity |
|------|-------|----------|
| Map must exist for all operations | `requireMap()` in tool handler — `if (!map) return err(...)` | Soft (error result, no throw) |
| Entity must exist for move/remove | `moveEntity()`, `removeEntity()` — `throw Error("Entity not found")` | Hard |
| Entity positions must be in bounds | `validateMap()` — checks `x,y` against `bounds` | Soft (validation warning) |
| PC entities should have character files | `validateMap()` — checks `PC:name` against character dir | Soft (validation warning) |

*Source: `src/tools/maps/index.ts`, `src/tools/filesystem/validation.ts`*

### Config

| Rule | Guard | Severity |
|------|-------|----------|
| config.json must be valid JSON | `validateJson()` | Soft (validation error) |
| `version` set to `CAMPAIGN_FORMAT_VERSION` at creation | `buildCampaignConfig()`, `createDefaultCampaignConfig()` | Informational (no runtime guard yet) |
| `createdAt` set to ISO 8601 timestamp at creation | `buildCampaignConfig()`, `createDefaultCampaignConfig()` | Informational (no runtime guard yet) |
| Entity files must have H1 title | `validateEntityFile()` | Soft (validation error) |
| Entity files should have Type field | `validateEntityFile()` | Soft (validation warning) |

*Source: `src/tools/filesystem/validation.ts`, `src/types/config.ts`, `src/tools/filesystem/config.ts`, `src/agents/setup-agent.ts`*

### Cross-Slice

| Rule | Guard | Severity |
|------|-------|----------|
| `CombatState.active` and `CombatClock.active` must stay in sync | `start_combat` handler calls both `clockStartCombat(state.clocks)` and `startCombat(state.combat, ...)`. `end_combat` handler calls both `endCombat(state.combat)` and `clockEndCombat(state.clocks)`. | Hard (enforced by tool handler pairing) |
| `switch_player` target must exist in `config.players` | `switch_player` handler — `if (idx === -1) return err(...)` | Soft (error result) |
| `activePlayerIndex` must be valid index into `config.players` | Only mutated by `switch_player`, which validates first | Hard (implicit) |

*Source: `src/agents/tool-registry.ts`*

---

## 6. State Lifecycle

### Session Start

```
Load config.json from campaignRoot
    │
    ├─ StatePersister.loadAll()
    │   ├─ Read state/combat.json   → hydrate GameState.combat    (or createCombatState())
    │   ├─ Read state/clocks.json   → hydrate GameState.clocks    (or createClocksState())
    │   ├─ Read state/maps.json     → hydrate GameState.maps      (or {})
    │   ├─ Read state/decks.json    → hydrate GameState.decks     (or createDecksState())
    │   ├─ Read state/scene.json    → hydrate SceneState subset   (precis, threads, intents, playerReads)
    │   ├─ Read state/conversation.json → ConversationManager.hydrate()
    │   └─ Read state/ui.json       → restore style/variant/modelines
    │
    ├─ detectSceneState(campaignRoot)
    │   ├─ Scan campaign/scenes/ for highest scene number
    │   ├─ Scan campaign/session-recaps/ for highest session number
    │   └─ Parse latest transcript.md → SceneState.transcript
    │
    ├─ Check pending-operation.json
    │   └─ If present → SceneManager.resumePendingTransition() (idempotent cascade)
    │
    ├─ Build DMSessionState
    │   ├─ Load rules/ → rulesAppendix
    │   ├─ Load campaign/log.md → campaignSummary
    │   ├─ Load session recap → sessionRecap
    │   └─ buildActiveState() → activeState
    │
    ├─ buildDMPrefix(config, sessionState) → cached system prompt
    │
    └─ SceneManager.sessionResume() → recap text for modal
```

### Exchange Loop

```
Player input
    │
    ├─ SceneManager.appendPlayerInput(characterName, text)
    │
    ├─ Build messages: getSystemPrompt() + conversation.getMessages() + new user message
    │
    ├─ Claude API call (Opus)
    │   └─ Response: text blocks + tool_use blocks
    │
    ├─ For each tool_use:
    │   ├─ ToolRegistry.dispatch(state, name, input) → ToolResult
    │   ├─ If tool in TOOL_STATE_MAP with slices:
    │   │   └─ onStateChanged → StatePersister.persist{Slice}()
    │   └─ If result is a command (UI/engine):
    │       └─ Agent loop handles: apply UI update, trigger scene transition, etc.
    │
    ├─ SceneManager.appendDMResponse(text)
    ├─ SceneManager.appendToolResult(name, result)  (for each tool)
    │
    ├─ ConversationManager.addExchange(user, assistant, toolResults)
    │   ├─ stubOldToolResults() — replace results older than stub_after with one-liners
    │   └─ enforceRetention()
    │       ├─ Drop oldest if exchanges > retention_exchanges
    │       ├─ Drop oldest if tokens > max_conversation_tokens
    │       └─ Return DroppedExchange if anything was dropped
    │
    ├─ If exchange was dropped:
    │   └─ SceneManager.handleDroppedExchange(client, dropped)
    │       └─ Haiku: updatePrecis() → append to SceneState.precis,
    │                 update openThreads, npcIntents, playerReads
    │
    └─ StatePersister.persistScene(), persistConversation()
```

### Scene Transition (9-step cascade)

Each step is tracked in `pending-operation.json` for idempotent recovery.

```
scene_transition(title, timeAdvance)
    │
    ├─ 1. finalize_transcript
    │     Write transcript.md to campaign/scenes/NNN-slug/
    │
    ├─ 2. campaign_log          (Haiku: scene summarizer)
    │     Append "## Scene N: Title\n{summary}" to campaign/log.md
    │
    ├─ 3. changelog_updates     (Haiku: changelog updater)
    │     Scan transcript, append one-line entries to entity files
    │
    ├─ 4. advance_calendar
    │     advanceCalendar(clocks, timeAdvance) — fires alarms
    │
    ├─ 5. check_alarms
    │     checkClocks(clocks) — read-only status check
    │
    ├─ 5b. validate
    │      validateCampaign() — entity files, wikilinks, maps, clocks, config
    │
    ├─ 6. reset_precis
    │     Clear precis, openThreads, npcIntents, playerReads
    │
    ├─ 7. prune_context
    │     conversation.clear() — empty the conversation window
    │
    ├─ 8. checkpoint
    │     repo.sceneCommit(title) — git snapshot
    │
    └─ 9. done
          Clear pending-operation.json
          Increment sceneNumber, reset slug + transcript
```

### Session End

```
session_end(title, timeAdvance)
    │
    ├─ Run full scene_transition cascade (steps 1–9)
    │
    ├─ Write session recap to campaign/session-recaps/session-NNN.md
    │
    └─ repo.sessionCommit(sessionNumber) — git snapshot
```

---

## 7. Filesystem Layout

Canonical directory tree for a campaign. Machine-managed files are marked with their corresponding state type.

```
<campaignRoot>/
├── config.json                            [machine] CampaignConfig. Written at init, read-only during play.
│                                          Manifest fields: version (CAMPAIGN_FORMAT_VERSION), createdAt (ISO 8601).
│
├── pending-operation.json                 [machine] PendingOperation. Crash recovery breadcrumb.
│
├── state/                                 [machine] All runtime state JSON files.
│   ├── combat.json                        CombatState
│   ├── clocks.json                        ClocksState
│   ├── maps.json                          Record<string, MapData>
│   ├── decks.json                         DecksState
│   ├── scene.json                         PersistedSceneState (precis, threads, intents, playerReads, activePlayerIndex)
│   ├── conversation.json                  SerializedExchange[]
│   └── ui.json                            PersistedUIState (themeName, keyColor, styleName, variant, modelines)
│
├── campaign/                              [machine + DM] The knowledge backbone.
│   ├── log.md                             [machine] Append-only campaign log. Dense, wikilinked.
│   ├── session-recaps/
│   │   └── session-NNN.md                 [machine] Haiku-generated session recaps.
│   └── scenes/
│       └── NNN-slug/
│           ├── transcript.md              [machine] Full scene transcript. Wikilinked.
│           └── dm-notes.md                [DM] DM-only notes (optional, DM-written).
│
├── players/                               [DM] Real human profiles.
│   └── <name>.md
│
├── characters/                            [DM + machine] PCs, NPCs, creatures.
│   ├── <name>.md                          Changelog section is machine-appended.
│   └── party.md                           Optional party-level notes.
│
├── locations/                             [DM + machine] Places with optional maps.
│   └── <slug>/
│       ├── index.md                       Changelog section is machine-appended.
│       └── <mapId>.json                   Map data (also in state/maps.json at runtime).
│
├── factions/                              [DM + machine]
│   └── <name>.md
│
├── lore/                                  [DM + machine]
│   └── <name>.md
│
└── rules/                                 [machine] Game system mechanics, rule cards.
    └── <topic>.md
```

**Machine-managed** = written by engine code, subagents, or tools. Never hand-edited during play.

**DM-managed** = written by the DM agent via entity tools (`create_entity`, `update_entity`) or file I/O. The machine only appends changelog entries.

**Dual** = characters, locations, factions, lore files are DM-created but have machine-appended changelog sections.

---

## 8. Evolution Notes

This document is a living reference. During gameplay testing:

- **Annotate friction points** directly in the relevant section. If a tool's access pattern turns out wrong, update the matrix.
- **Track subagent visibility changes.** If a subagent needs more context than listed, note what was added and why — context creep is a cost concern.
- **Record new invariants** as they're discovered. Many invariants only surface under gameplay pressure (e.g., "what happens when combat ends mid-scene-transition?").
- **Watch the cross-slice sync points.** The `CombatState.active ↔ CombatClock.active` pairing is the first of potentially many. If more appear, consider a unified state transaction pattern.
- **Monitor persistence timing.** Write-through persistence is fire-and-forget. If state loss becomes an issue, track which slices are most vulnerable and consider batching or confirmation.

When this document diverges from the code, the code wins. Update the atlas.
