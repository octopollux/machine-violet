# Module Map

Every `src/` directory, what it contains, and where to find key code. Most directories have `index.ts` barrel exports — check those before reaching into subdirectories.

## src/agents/ — Orchestration

The game loop, state management, and AI session handling.

| File | Purpose |
|---|---|
| `game-state.ts` | `GameState` interface — the single mutable state object |
| `game-engine.ts` | Main orchestrator: callbacks, turn management, scene transitions |
| `agent-loop.ts` | Single-turn conversation loop: streaming, tool handling, usage |
| `agent-session.ts` | Session wrapper: retries, thinking config, terse suffix |
| `tool-registry.ts` | All tool definitions + `TOOL_STATE_MAP` + dispatch |
| `scene-manager.ts` | `SceneState`, transitions, pending operations, precis updates |
| `dm-prompt.ts` | `DMSessionState`, system prompt builder, active state formatting |
| `setup-agent.ts` | Campaign initialization wizard (delegates to setup-conversation subagent) |
| `world-builder.ts` | Campaign scaffolding, entity creation helpers |
| `player-manager.ts` | Turn switching, active player tracking |
| `subagent.ts` | `spawnSubagent()`, `oneShot()` — subagent spawning infrastructure |

### src/agents/subagents/ — Specialized agents

Each file is an isolated Claude conversation for a specific task. All use `spawnSubagent()` or `oneShot()` from `subagent.ts`.

| File | Model | Purpose |
|---|---|---|
| `scene-summarizer.ts` | Haiku | Scene transcript → campaign log entry |
| `precis-updater.ts` | Haiku | Dropped exchange → precis append + PlayerRead extraction |
| `changelog-updater.ts` | Haiku | Scene transcript → entity changelog entries |
| `compendium-updater.ts` | Haiku | Scene transcript → player-facing compendium update |
| `resolve-session.ts` | Sonnet | Persistent combat resolution engine (accumulates context across turns) |
| `choice-generator.ts` | Haiku | Generate 2-3 player action choices from recent narration |
| `character-promotion.ts` | Haiku | Expand minimal NPC → full character sheet |
| `scribe.ts` | Haiku | Autonomous entity file manager (list/read/write tools, 8 rounds) |
| `search-campaign.ts` | Haiku | Agentic campaign search (grep/read tools, 5 rounds) |
| `narrative-recap.ts` | Haiku | Bullet recap → prose for "Previously on..." modal |
| `repair-state.ts` | Haiku | Scan transcripts, generate missing entity files |
| `theme-styler.ts` | Haiku | Natural-language theme description → theme commands |
| `ai-player.ts` | Haiku/Sonnet | AI character decision-making for NPC players |
| `ooc-mode.ts` | Sonnet | Out-of-character conversation (rules, corrections, rollback) |
| `setup-conversation.ts` | Sonnet | Interactive campaign setup wizard |
| `dev-mode.ts` | Sonnet | Developer console (state inspection, file I/O, mutation) |

## src/tools/ — Game Mechanics

Stateless game rule engines. Each subdirectory is a domain. Tool handlers take `(state, input)` and return `ToolResult`.

| Directory | Key exports |
|---|---|
| `dice/` | `rollDice()`, `parseExpression()`, `evaluate()`, `seededRng()`, `cryptoRng` |
| `cards/` | `deck()` (create/shuffle/draw/peek/return), `createStandard52()`, `createTarot()` |
| `clocks/` | `createClocksState()`, `setAlarm()`, `clearAlarm()`, `advanceCalendar()`, `nextRound()`, `checkClocks()` |
| `combat/` | `startCombat()`, `endCombat()`, `advanceTurn()`, `modifyInitiative()` |
| `objectives/` | `createObjectivesState()`, `manageObjectives()` — long-lifecycle player-facing goals |
| `maps/` | `createMap()`, `viewArea()`, `distance()`, `pathBetween()`, `lineOfSight()`, `placeEntity()`, `moveEntity()` |
| `filesystem/` | `parseFrontMatter()`, `serializeEntity()`, `extractWikilinks()`, `campaignDirs()`, `campaignPaths()`, `validateConfig()`, `sandboxFileIO()` |
| `git/` | `CampaignRepo`, `createGitIO()`, `queryCommitLog()`, `performRollback()` |
| `campaign-ops/` | `walkCampaignFiles()`, `findReferences()`, `renameEntity()`, `mergeEntities()`, `resolveDeadLinks()` |
| `validation/` | `validateCampaign()` |

## src/context/ — Context Window Management

Token tracking, conversation window, prompt caching, state persistence.

| File | Purpose |
|---|---|
| `conversation.ts` | `ConversationManager` — exchange tracking, retention enforcement, tool result stubbing |
| `prefix-builder.ts` | `buildCachedPrefix()` — system prompt assembly with cache breakpoints |
| `state-persistence.ts` | `StatePersister` — serialize/deserialize state to `state/*.json` |
| `cost-tracker.ts` | `CostTracker` — usage by tier (input, cache read/write, output) |
| `campaign-log.ts` | `renderCampaignLog()` — campaign history rendering |
| `token-counter.ts` | `estimateTokens()` — tiktoken-based estimation |
| `usage-helpers.ts` | `accumulateUsage()` — merge Anthropic Usage objects |
| `display-log.ts` | Narrative line ↔ markdown conversion |

## src/tui/ — Terminal UI

Ink (React for CLI) components, formatting pipeline, theme system.

| Directory/File | Purpose |
|---|---|
| `layout.tsx` | Main game layout (modeline + narrative + input) |
| `formatting.ts` | DM text formatting pipeline: raw → AST → wrapped → rendered |
| `render-nodes.tsx` | `FormattingNode[]` → Ink `<Text>` elements |
| `responsive.ts` | Terminal size detection and layout tier selection |
| `activity.ts` | Activity/status bar state management |
| `game-context.ts` | React context for game engine callbacks |
| `components/` | Reusable: `Modeline`, `InputLine`, `NarrativeArea`, `PlayerSelector`, `ActivityLine`, `FrameBorder`, `FullScreenFrame` |
| `modals/` | `CenteredModal`, `ChoiceModal`, `CharacterSheetModal`, `CompendiumModal`, `DiceRollModal`, `SessionRecapModal`, `GameMenu`, `ApiErrorModal`, `SwatchModal`, `CampaignSettingsModal`, `RollbackSummaryModal`, `PlayerNotesModal` |
| `themes/` | Theme parser, loader, resolver. Built-in themes in `themes/assets/` |
| `color/` | OKLCH color space utilities, gradient generation |
| `frames/` | Box drawing, styled content lines, string measurement |
| `hooks/` | `useGameCallbacks()`, `useTextInput()`, `useTerminalSize()`, `useScrollHandle()`, `useMouseScroll()` |

## src/config/ — Configuration

Model selection, campaign init, DM personalities, campaign seeds.

| File | Purpose |
|---|---|
| `models.ts` | `getModel("large" \| "medium" \| "small")` — tier model selection (cached; tests need `loadModelConfig({ reset: true })`) |
| `personalities.ts` | `PERSONALITIES`, `getPersonality()` — DM personality definitions |
| `seeds.ts` | `SEEDS`, `seedsForGenre()` — campaign premise seeds by genre |
| `first-launch.ts` | `.env` loading, config paths, API key format validation |
| `main-menu.ts` | Campaign listing and selection |
| `tokens.ts` | `TOKEN_LIMITS` — model token capacity constants |
| `dev-mode.ts` | Dev override detection, FileIO wrapping for dev logging |

## src/types/ — Type Definitions

Shared TypeScript interfaces. No implementations. All re-exported from `index.ts`.

| File | Key types |
|---|---|
| `config.ts` | `CampaignConfig`, `PlayerConfig`, `ContextConfig`, `RecoveryConfig` |
| `maps.ts` | `MapData`, `MapEntity`, `MapRegion`, `CoordKey` |
| `combat.ts` | `CombatState`, `Combatant`, `InitiativeEntry`, `CombatConfig` |
| `clocks.ts` | `ClocksState`, `Alarm`, `CalendarClock`, `CombatClock` |
| `cards.ts` | `DecksState` (wrapper: `{ decks: Record<string, DeckState> }`), `Card`, `DeckState` |
| `dice.ts` | `DiceRollResult`, `RollDiceInput`, `DiceExpression` |
| `entities.ts` | `EntityFrontMatter` |
| `tui.ts` | `NarrativeLine`, `FormattingNode`, modal types |
| `compendium.ts` | `Compendium`, `CompendiumEntry`, `CompendiumCategory` |

## src/content/ — Content Pipeline

PDF ingestion and content processing. **Completely separate from the game engine** — the only shared interface is the filesystem format. If you delete this module, the game still runs.

| File | Purpose |
|---|---|
| `pdf-extract.ts` | Local PDF text extraction via pdf-parse (no AI, no API calls) |
| `pdf-split.ts` | PDF splitting (pdf-lib) and validation (`getPdfInfo()`) |
| `batch-client.ts` | Anthropic Batch API helpers (polling, result collection) — for future processing pipeline |
| `job-manager.ts` | Ingest job CRUD, collection manifests, status tracking |
| `cache-writer.ts` | Write extracted pages to per-page .md cache files |
| `ingest.ts` | Top-level orchestrator: validate → extract → cache → report |
| `types.ts` | Interfaces for jobs, chunks, extraction results |

## src/phases/ — App Lifecycle

State machine for the application: main menu → setup / add content → playing → returning_to_menu → main menu (loop). On first launch, config.json is auto-created with defaults.

| File | Purpose |
|---|---|
| `MainMenuPhase.tsx` | Themed campaign selection screen with New Campaign, Continue, Add Content, Quit |
| `AddContentPhase.tsx` | PDF import flow: name collection → drop files → validate → extract → cache |
| `SetupPhase.tsx` | Campaign creation/load orchestration |
| `PlayingPhase.tsx` | Main game loop (hosts GameEngine) |

## src/prompts/ — Prompt Templates

Markdown files loaded at runtime via `loadPrompt(name)` (sync, cached, CRLF→LF normalized). Template interpolation via `loadTemplate(name, vars)` with `{{placeholder}}` syntax.

Key prompts: `dm-identity.md` (DM behavioral instructions), plus one `.md` per subagent (named to match).

Tests must call `resetPromptCache()` in `beforeEach`.

## src/commands/ — Slash Commands

Player commands during gameplay. `trySlashCommand()` parses and dispatches.

## systems/ — Game System Templates

Content assets at the repo root (not in `src/`). Each system gets a subdirectory copied to campaign state at init.

| File | Purpose |
|---|---|
| `<system-id>/metadata.json` | System identity, license, complexity, dice requirements |
| `<system-id>/rule-card.md` | XML-directive format core mechanics reference, hand-authored by Opus |

Currently bundled: `24xx`, `breathless`, `cairn`, `charge`, `dnd-5e`, `fate-accelerated`, `ironsworn`.

## src/utils/ — Utilities

Platform abstractions and helpers that don't belong to any single domain.

| File | Purpose |
|---|---|
| `clipboard.ts` | `ClipboardIO` interface, `copyToClipboard()`, `readFromClipboard()` — cross-platform clipboard via `clipboardy`, lazy-loaded. `setClipboardIO()` for test mocking |
| `paths.ts` | Runtime asset path resolution (prompts, themes, systems relative to executable) |

## Root Files

| File | Purpose |
|---|---|
| `src/app.tsx` | Root Ink component — phase state machine, FileIO/GitIO setup, cost tracking |
| `src/index.tsx` | Entry point — Ink render, raw mode guards |
| `src/shutdown.ts` | Graceful shutdown helper (files, git, terminal) — called by teardown.ts |
| `src/teardown.ts` | Return-to-menu teardown: graceful shutdown + cache reset |
