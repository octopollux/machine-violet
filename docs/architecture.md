# Architecture

How the system works, mapped to actual code paths.

## Core Loop

The game is a single Ink (React for CLI) process. There is no frontend/backend split. The DM agent calls tools that directly manipulate UI state and game state.

```
Player input
  → GameEngine (src/agents/game-engine.ts)
    → builds messages: system prompt + conversation history + new input
    → Claude API call (Opus tier)
    → response: text blocks + tool_use blocks
      → ToolRegistry.dispatch() for each tool
      → StatePersister writes changed state slices
      → UI commands applied to Ink components
    → ConversationManager tracks the exchange
    → if exchange dropped from window: Haiku precis updater runs
  → DM text rendered to terminal
```

**Entry point:** `src/index.tsx` → `src/app.tsx` (phase state machine) → `PlayingPhase` → `GameEngine`

## Execution Tiers

Every operation has an explicit cost tier. This is the core economic constraint.

| Tier | Model | Cost | Used for | Code path |
|---|---|---|---|---|
| T1 (Code) | None | Zero tokens | Dice, maps, clocks, cards, combat, persistence | `src/tools/` — pure functions |
| T2 (Subagent) | Haiku or Sonnet | Cheap | Summarization, precis, changelogs, resolution, choices, entity writes | `src/agents/subagents/` — `spawnSubagent()` / `oneShot()` |
| T3 (DM) | Opus | Expensive | Narration, scene direction, NPC dialogue | `src/agents/agent-loop.ts` — main conversation |

Model selection: `src/config/models.ts` — `getModel("large" | "medium" | "small")`. Override via `dev-config.json`.

## State Architecture

**GameState** (`src/agents/game-state.ts`) is the single mutable source of truth. Passed to every tool handler. Contains:

- `maps` — spatial data (grids, entities, terrain, regions)
- `clocks` — calendar time + combat rounds + alarms
- `combat` — initiative order, turn tracking
- `decks` — card decks (draw piles, discard, hands)
- `config` — campaign config (read-only during play)
- `campaignRoot` — filesystem path
- `activePlayerIndex` — current player

**Shadow state** (not in GameState, managed separately):

- **SceneState** (`src/agents/scene-manager.ts`) — transcript, precis, open threads, NPC intents, player reads
- **ConversationManager** (`src/context/conversation.ts`) — exchange history with retention enforcement
- **DMSessionState** (`src/agents/dm-prompt.ts`) — transient prefix data, rebuilt from files each session

**Persistence:** All state serializes to JSON under `<campaignRoot>/state/`. `StatePersister` (`src/context/state-persistence.ts`) writes specific slices after tool dispatch, keyed by `TOOL_STATE_MAP` in `tool-registry.ts`.

Full schema and invariants: [state-atlas.md](state-atlas.md)

## Context Window Management

The DM's context is structured in layers with cache breakpoints:

```
[BP1] System prompt + rules appendix        ← cached 1h, rebuilt on scene change
[BP2] Campaign summary + session recap       ← cached 1h, rebuilt on scene change
      + scene precis + active state
[BP3] Tool definitions                       ← cached per request
[BP4] Conversation exchanges                 ← accumulates within scene, cached rate
      + current player input
```

Conversation accumulates within a scene and is cleared at scene transition. With automatic caching, prior exchanges are read at cache rate. A `max_conversation_tokens` safety brake drops oldest exchanges in unusually long scenes; when that fires, a Haiku precis updater compresses the dropped exchange into the scene precis.

**Code:** `src/context/prefix-builder.ts` (prefix assembly), `src/context/conversation.ts` (retention), `src/agents/scene-manager.ts` (precis updates)

Full details: [context-management.md](context-management.md)

## Scene Transitions

Scene transitions are idempotent 9-step cascades. Each step is tracked in `pending-operation.json` for crash recovery.

```
1. finalize_transcript      → write transcript.md
2. subagent_updates         → Haiku: campaign log + changelogs (parallelized)
3. advance_calendar         → fire alarms
4. check_alarms             → read-only status
5. validate                 → campaign state checks
6. reset_precis             → clear scene-scoped state
7. prune_context            → empty conversation window
8. checkpoint               → git commit
9. done                     → clear pending-operation.json
```

**Code:** `src/agents/scene-manager.ts` — `sceneTransition()`, `resumePendingTransition()`

## Entity Filesystem

The campaign directory is the database. All game content is markdown with `**Key:** Value` front matter and `[[wikilinks]]`. The DM navigates knowledge by following links, not by re-reading context.

```
<campaignRoot>/
├── config.json              Campaign config (read-only during play)
├── state/                   Runtime state JSON
├── campaign/
│   ├── log.md               Append-only campaign log
│   ├── session-recaps/      Haiku-generated recaps
│   └── scenes/NNN-slug/     Scene transcripts + DM notes
├── characters/              PCs, NPCs, creatures
├── locations/               Places + map JSON
├── factions/                Organizations
├── lore/                    World knowledge
└── rules/                   Game system mechanics
```

Entity I/O is abstracted through **FileIO** and **GitIO** interfaces. Production uses real `fs`; tests inject in-memory mocks.

**Code:** `src/tools/filesystem/` (parsing, validation, scaffolding), `src/agents/subagents/scribe.ts` (entity writes)

Full details: [entity-filesystem.md](entity-filesystem.md)

## Subagent Pattern

Delegation is mandatory — the DM never does mechanical work. `spawnSubagent()` creates an isolated Claude conversation with its own context window. The DM's context is never polluted.

```typescript
// One-shot pattern (most subagents)
const result = await oneShot(client, {
  model: getModel("small"),  // Haiku
  system: systemPrompt,
  prompt: inputText,
});

// Multi-turn pattern (scribe, OOC, dev mode)
const result = await spawnSubagent(client, {
  model: getModel("small"),
  system: systemPrompt,
  messages: [...],
  tools: [...],
  maxToolRounds: 8,
});
```

**Code:** `src/agents/subagent.ts` (infrastructure), `src/agents/subagents/` (all subagent implementations)

Full catalog: [subagents-catalog.md](subagents-catalog.md)

## Tool System

Tools are registered in `src/agents/tool-registry.ts` with JSON Schema input definitions. The DM calls tools by name; the registry dispatches to handler functions.

Tool handlers receive `(state: GameState, input: T)` and return `ToolResult`:
- `ok(data)` — success with content string
- `err(message)` — error with `is_error: true`
- UI/engine commands — returned as structured objects, handled by the agent loop

Tools are organized by domain in `src/tools/`: dice, cards, clocks, combat, maps, filesystem, git, validation.

Full catalog: [tools-catalog.md](tools-catalog.md)

## TUI Rendering

The terminal UI is built with Ink (React for CLI). The main layout (`src/tui/layout.tsx`) composes:

- **Modeline** — status bar (mode, turn, resources, cost)
- **NarrativeArea** — scrollable DM text with formatting
- **InputLine** — player text input

DM text goes through a formatting pipeline (`src/tui/formatting.ts`):
```
raw string → heal tags → parse to FormattingNode[] AST → wrap lines → pad alignment → quote highlight
```

Tags supported: `<b>`, `<i>`, `<u>`, `<center>`, `<right>`, `<color=#hex>`. Quote state resets at paragraph boundaries.

**Theme system:** `.theme` asset files in `src/tui/themes/assets/` define color palettes using OKLCH color space. Variants: exploration, combat, ooc, levelup, dev.

**Code:** `src/tui/` (components, formatting, themes, modals, hooks)

Full details: [tui-design.md](tui-design.md)
