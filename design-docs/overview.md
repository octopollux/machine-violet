# tui-rpg: An Agentic RPG in Your Console

TUI-RPG is an agentic DM and game state manager designed to run any tabletop RPG in a terminal. The AI is the Dungeon Master — it narrates, adjudicates, manages the world, and manipulates the UI directly. The player never sees game files or internal state. Everything is narrated.


## Architecture

tui-rpg is a single Ink (React for CLI) application. The game engine, Claude SDK integration, and TUI are all one process — no abstraction layer between engine and interface. The DM agent has tools that manipulate both game state and the UI directly, so it can do things that weren't anticipated at design time.

Game state lives on the filesystem as markdown and JSON. Automatic git snapshots (via isomorphic-git, no system dependency) provide rollback and recovery. A web API could be exposed later but is not an architectural prerequisite.

Tech stack:
- **Runtime**: Node.js (18+)
- **Language**: TypeScript
- **UI**: Ink (React for CLI)
- **AI**: Anthropic Claude SDK (Opus for DM, Sonnet for setup/OOC, Haiku for mechanical tasks)
- **State**: Filesystem (markdown + JSON) with isomorphic-git for snapshots
- **Document import**: Claude vision for PDF extraction


## Execution Tiers

Work is pushed down to the cheapest tier that can handle it reliably. See [Context Management Design](context-management.md) for cost modeling.

| Tier | Cost | Handles |
|---|---|---|
| **Tier 1: Code** | Zero tokens | Dice rolls, spatial math, pathfinding, viewport rendering, clock arithmetic, file I/O |
| **Tier 2: Haiku/Sonnet** | Cheap tokens | Action resolution, rule lookups, transcript summarization, PDF parsing, OOC mode |
| **Tier 3: Opus** | Expensive tokens | Narration, NPC personality, creative decisions, rule judgment, dramatic pacing |

A tool is worth building if it saves significant tokens or if the model would be unreliable without it.


## The Game World

### Filesystem as Database
The campaign directory is the database. The campaign transcript is the knowledge backbone — dense with wikilinks to entity files, serving as both narrative record and the DM's index into the game world. Entity types: players, characters, locations, factions, lore (grab-bag), rules, and the campaign log. Every entity reference in a transcript is a wikilink. PC character sheets are the one piece of state the player may see. → [Entity Filesystem Design](entity-filesystem.md)

### Tile Maps
Locations can have tile maps — sparse JSON structures with a tool layer for spatial queries, viewport rendering, and entity management. Supports square and hex grids. The DM sees small rendered viewports, not raw data. → [Map System Design](map-system.md)

### Clocks and Alarms
Two clocks manage time automatically. A **calendar** tracks narrative time and advances via scene transitions. A **round counter** tracks combat turns. Both support alarms that fire notifications into the DM's context invisibly to the player. → [Clocks and Alarms Design](clocks-and-alarms.md)


## Game Systems

tui-rpg ships with support for freely available RPG systems (fetched at runtime), a catalog of pre-built options, and the ability to import user-supplied sourcebooks via PDF. A "Just jump in" mode uses a hidden lightweight system (24XX or text-adventure conventions) for zero-friction freeform play. → [Rules Systems Reference](rules-systems.md), [Document Ingestion Design](document-ingestion.md)


## Randomization

Dice, cards, and random tables are handled by Tier 1 code (true randomness) combined with a Tier 2 resolution subagent (Haiku reads rules, determines modifiers, interprets results). Tools return mechanistic results (individual die values, not just totals). Resource pools live on character sheets, not in a separate system. Player-claimed rolls are validated but accepted. → [Randomization Tools Design](randomization.md)


## Subagents

A subagent is a nested Claude API conversation with its own context window. The DM delegates a task; the subagent works through it and returns a terse result. The DM's context is not polluted by intermediate steps.

**Silent** (DM-only): NPC dice rolls, rule lookups, transcript summarization, PDF parsing.

**Player-facing** (takes over the TUI): Character generation, level-up, OOC mode.

OOC mode is a sandboxed Sonnet subagent. It receives the DM's context on entry, handles rules questions, transcript searches, and configuration changes, and returns only a terse summary to the DM when it ends. The DM controls OOC entry and exit via tools.


## Scene and Session Management

Scenes are an engine concept, not a game-system concept. A scene transition is a commit point — the DM signals a structural moment and the engine handles a cascade of housekeeping: transcript finalization, campaign log updates, clock advancement, alarm checks, context window pruning, and state checkpointing.

- **`scene_transition`**: natural narrative boundary. Fires Tier 1 bookkeeping + Tier 2 summarization. Returns alarm notifications and a clean slate.
- **`session_end`**: saves a session recap for next time.
- **`session_resume`**: "previously on..." — loads campaign state into the DM's fresh context.
- **`context_refresh`**: mid-scene reorientation without a full scene break.

→ [Context Management Design](context-management.md)


## Game Initialization

After a one-time API key and home directory prompt, the entire setup process is agentic (Sonnet). Structured choices (3-5 options + freeform) at each step. A "Just jump in" fast path gets the player into a random game in under a minute by mashing Enter. Players choose a genre, system, campaign seed, DM personality (swappable prompt fragment, Rimworld-style), and character. → [Game Initialization Design](game-initialization.md)

### Persistent Data Location
Campaign directories, cached rules, and app configuration live under a platform-specific home directory chosen to land inside cloud-synced folders by default (Documents on Windows/macOS).


## Multiplayer and AI Players

Multiplayer is hot-seat — multiple players share one terminal. A player bar at the bottom of the TUI shows who's active. Outside initiative, players switch freely with a hotkey. During initiative, the system controls turn order.

AI players are trivially simple — a Haiku/Sonnet call replacing human input, using the character's personality prompt and sheet. Enables solo-with-party, mixed parties, and demo mode. → [Multiplayer and Initiative Design](multiplayer-and-initiative.md)


## TUI

The layout is a bordered narrative window with DM-controlled chrome. Bottom to top: player selector, input line, modeline, styled lower frame (turn indicator), activity line, scrolling DM text, top frame (resource display). Left/right frames complete the border. Frame styles are pre-baked per genre with combat/exploration/OOC/level-up variants — the DM (or engine) swaps variants via tools. The top frame shows the active character's key resources (Tier 1, configurable keys pointing into the character sheet). The activity line shows automatic indicators for in-flight engine operations. The DM can use inline formatting tags (`<b>`, `<i>`, `<u>`, justification, hex colors) sparingly for dramatic effect. Themed modals handle character sheets, player choices, dramatic dice rolls, session recaps, and the ESC game menu. A `present_choices` tool lets the DM (or a Haiku subagent, automatically) offer structured A/B/C options with freeform always available — frequency is configurable per campaign and per player. Responsive design degrades gracefully from full chrome (≥80×40) down to bare DM text + input (20×12). → [TUI Design](tui-design.md)

### Visual conventions
- **Entity colors**: enemies red, allies green, neutral gray. PCs pick their own color. Custom colors for special entities.
- **Dice display**: automatic rolls show results in styled text ("Rolled 2d20kh1+5: [18,7] → 23"). Crits are highlighted.
- **Player rolls**: players can roll physical dice and report results; the engine validates and fires hooks.


## Error Recovery

Automatic git snapshots provide point-in-time rollback. API failures retry with backoff; sustained outages save and resume. Multi-step cascades (like scene transitions) are idempotent and resumable. Periodic validation checks catch state drift between files. Players can request rollback, corrections, and consistency checks via OOC mode. → [Error Recovery Design](error-recovery.md)


## DM Prompt and Guidance

The DM is not an assistant — it runs a world. The system prompt establishes role (decide things, say no, let bad things happen, have secrets, surprise yourself), voice (personality via swappable DM personality fragments), and tool discipline (call the tool when state changes, delegate mechanical work to subagents).

Agent-facing documents should be written densely, using shorthand and cultural/literary references to maximize information per token. The dice-for-narrative-choices pattern (prepare options, roll to choose) keeps storytelling unpredictable. → [DM Developer Prompt](dm-prompt.md)


## Implementation Constraints

**Cross-platform packaging.** The app must be buildable into installation packages for Windows, macOS, and Linux. Not implemented now, but nothing in the codebase should preclude it. Constraints: no native addons that don't cross-compile, no hard-coded path separators, no platform-specific shell assumptions in app code. isomorphic-git (already chosen) avoids the system git dependency. Packaging mechanism (pkg, caxa, Node SEA) is a deferred build-time decision.

**Testability of agentic outputs.** Where AI outputs have testable structure, validate them with static test code in addition to normal unit/integration testing. Tier 1 tools are fully deterministic (use seeded RNG for dice). Tier 2 subagent outputs have defined return schemas — validate shape, bounds, and consistency (damage within weapon range, HP non-negative, wikilinks resolve, etc.). The filesystem wikilink contract, entity file format, JSON validity, and changelog structure are all verifiable by code. The TUI formatting parser is deterministic and fully testable.


## Design Documents Index

| Document | Topic |
|---|---|
| [Map System](map-system.md) | Sparse JSON maps, spatial tools, viewport rendering |
| [Entity Filesystem](entity-filesystem.md) | Entity types, folder structure, wikilinks, changelogs |
| [Randomization Tools](randomization.md) | Dice, cards, action resolution, hooks |
| [Rules Systems Reference](rules-systems.md) | Free game system catalog, licensing, freeform play |
| [DM Developer Prompt](dm-prompt.md) | DM system prompt draft and engineering notes |
| [Document Ingestion](document-ingestion.md) | PDF import pipeline, batch API |
| [Context Management](context-management.md) | Token economics, retention policy, cost modeling |
| [Clocks and Alarms](clocks-and-alarms.md) | Calendar, combat rounds, alarm system |
| [Game Initialization](game-initialization.md) | Setup flow, campaign seeds, DM personalities |
| [Multiplayer and Initiative](multiplayer-and-initiative.md) | Hot-seat, AI players, turn order |
| [Error Recovery](error-recovery.md) | Git snapshots, rollback, validation |
| [TUI Design](tui-design.md) | Layout, frames, styles, responsive design, DM formatting |
| [Tools Catalog](tools-catalog.md) | All 37 tools by domain, signatures, tiers |
| [Subagents Catalog](subagents-catalog.md) | All 14 subagent patterns, models, visibility |
| [Development Plan](development-plan.md) | 10-phase implementation roadmap, dependency graph, testing strategy |
| [State Atlas](state-atlas.md) | Runtime state schema, tool×state matrix, invariants, lifecycle |
