# Module Map

The codebase is split across three packages:

- **`packages/engine/`** — Game engine, AI agents, tools, state, prompts, Fastify server
- **`packages/client-ink/`** — Ink TUI, themes, modals, formatting, phases
- **`packages/shared/`** — Shared types and protocol schemas

Most directories have `index.ts` barrel exports — check those before reaching into subdirectories. Paths below are relative to their package root (e.g. `agents/game-engine.ts` = `packages/engine/src/agents/game-engine.ts`).

## Engine: agents/ — Orchestration

The game loop, state management, and AI session handling.

| File | Purpose |
|---|---|
| `game-state.ts` | `GameState` interface — the single mutable state object |
| `game-engine.ts` | Main orchestrator: callbacks, turn management, scene transitions |
| `agent-loop.ts` | Single-turn conversation loop: streaming, tool handling, usage |
| `tool-registry.ts` | All tool definitions + `TOOL_STATE_MAP` + dispatch |
| `scene-manager.ts` | `SceneState`, transitions, pending operations, precis updates |
| `dm-prompt.ts` | `DMSessionState`, system prompt builder, active state formatting |
| `setup-agent.ts` | Campaign initialization wizard (delegates to setup-conversation subagent) |
| `world-builder.ts` | Campaign scaffolding, entity creation helpers |
| `player-manager.ts` | Turn switching, active player tracking |
| `subagent.ts` | `spawnSubagent()`, `oneShot()` — subagent spawning infrastructure |

### Engine: agents/subagents/ — Specialized agents

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

## Engine: tools/ — Game Mechanics

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

## Engine: context/ — Context Window Management

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
| `engine-log.ts` | Structured append-only JSONL event log at `../.debug/engine.jsonl` (relative to campaigns dir): server/session/turn lifecycle, API calls, errors. Non-blocking fire-and-forget |

## Client: agent-sidecar.ts — Dev-only Agent API

Dev-only HTTP server for AI agent integration testing (`--agent-port` or `MV_AGENT_PORT`). Embeds in the TUI client, provides screen capture via `@xterm/headless`, state inspection, and keystroke injection. Endpoints: `GET /screen` (plain text or `?ansi=true`), `GET /state` (JSON), `POST /input` (raw bytes), `POST /input/key` (named key via KEY_MAP). Excluded from release builds.

## Client: tui/ — Terminal UI

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
| `modals/` | `CenteredModal`, `ChoiceModal`, `CharacterSheetModal`, `CompendiumModal`, `DiceRollModal`, `SessionRecapModal`, `GameMenu`, `ApiErrorModal`, `SwatchModal`, `CampaignSettingsModal`, `RollbackSummaryModal`, `PlayerNotesModal`, `DeleteCampaignModal`, `CharacterPane` (right-side overlay for active character stats/inventory, lazy-fetched), `OverlayPane` (reusable right-aligned overlay base with themed borders, scrolling, word-wrap) |
| `themes/` | Theme parser, loader, resolver. Built-in themes in `themes/assets/` |
| `color/` | OKLCH color space utilities, gradient generation |
| `frames/` | Box drawing, styled content lines, string measurement |
| `hooks/` | `useTextInput()`, `useScrollHandle()`, `useMouseScroll()`, `kittyProtocol.ts` (Kitty keyboard protocol detection, CSI-u parsing, legacy re-emission), `stdinFilterChain.ts` (managed stdin filter pipeline for Kitty + mouse scroll interception) |

## Engine: config/ — Configuration

Model selection, campaign init, DM personalities, campaign seeds.

| File | Purpose |
|---|---|
| `models.ts` | `getModel("large" \| "medium" \| "small")` — tier model selection (cached; tests need `loadModelConfig({ reset: true })`) |
| `connections.ts` | Multi-provider connection management: load/save/add/remove connections, tier assignments. Supports Anthropic, OpenAI, OpenRouter, custom providers. Persists to `connections.json` |
| `discord.ts` | Discord integration settings: opt-in/opt-out state persisted to `discord-settings.json` |
| `model-registry.ts` | Dynamic model registry: shipped `known-models.json` merged with user `model-overrides.json`. Pricing, capabilities, context windows, tier defaults per provider |
| `personalities.ts` | `PERSONALITIES`, `getPersonality()` — DM personality definitions |
| `seeds.ts` | `SEEDS`, `seedsForGenre()` — campaign premise seeds by genre |
| `first-launch.ts` | `.env` loading, config paths, API key format validation |
| `campaign-archive.ts` | `archiveCampaign()`, `unarchiveCampaign()`, `deleteCampaign()`, `listArchivedCampaigns()`, `getCampaignDeleteInfo()` — campaign archival, restoration, and deletion with verification |
| `main-menu.ts` | Campaign listing and selection |
| `tokens.ts` | `TOKEN_LIMITS` — model token capacity constants |
| `machine-settings.ts` | Machine-scoped settings persistence (`machine-settings.json`) — feature flags like `devModeEnabled` |
| `file-io-logger.ts` | FileIO wrapper for debug read/write/append logging |

## Shared: types/ — Type Definitions

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

## Engine: content/ — Content Pipeline

PDF ingestion and content processing. **Completely separate from the rest of the game engine** — the only shared interface is the filesystem format. If you delete this module, the game still runs.

| File | Purpose |
|---|---|
| `pdf-extract.ts` | Local PDF text extraction via pdf-parse (no AI, no API calls) |
| `pdf-split.ts` | PDF splitting (pdf-lib) and validation (`getPdfInfo()`) |
| `batch-client.ts` | Anthropic Batch API helpers (polling, result collection) — for future processing pipeline |
| `job-manager.ts` | Ingest job CRUD, collection manifests, status tracking |
| `cache-writer.ts` | Write extracted pages to per-page .md cache files |
| `ingest.ts` | Top-level orchestrator: validate → extract → cache → report |
| `types.ts` | Interfaces for jobs, chunks, extraction results |

## Client: phases/ — App Lifecycle

State machine for the application: main menu → playing (setup or gameplay) / add content → returning_to_menu → main menu (loop). On first launch, config.json is auto-created with defaults. Setup runs as a pseudo-campaign session inside PlayingPhase (SetupPhase was removed in #311).

| File | Purpose |
|---|---|
| `MainMenuPhase.tsx` | Themed campaign selection screen with New Campaign, Continue (with Archive/Delete columns), Add Content (Dev Mode only), Quit |
| `ArchivedCampaignsPhase.tsx` | List archived campaign zips with dates, select to unarchive |
| `AddContentPhase.tsx` | PDF import flow: name collection → drop files → validate → extract → cache |
| `PlayingPhase.tsx` | Main game loop — handles both gameplay and setup (setup runs as a pseudo-campaign session) |

## Engine: prompts/ — Prompt Templates

Markdown files loaded at runtime via `loadPrompt(name)` (sync, cached, CRLF→LF normalized). Template interpolation via `loadTemplate(name, vars)` with `{{placeholder}}` syntax.

Key prompts: `dm-identity.md` (identity preamble) and `dm-directives.md` (directives, voice, craft, formatting, tools — emitted after the personality so persona-specific register claims the seat before the generic rules), plus one `.md` per subagent (named to match).

Tests must call `resetPromptCache()` in `beforeEach`.

## Client: commands/ — Slash Commands

Player commands during gameplay. `trySlashCommand()` parses and dispatches.

## systems/ — Game System Templates

Content assets at the repo root (not in `src/`). Each system gets a subdirectory copied to campaign state at init.

| File | Purpose |
|---|---|
| `<system-id>/metadata.json` | System identity, license, complexity, dice requirements |
| `<system-id>/rule-card.md` | XML-directive format core mechanics reference, hand-authored by Opus |

Currently bundled: `24xx`, `breathless`, `cairn`, `charge`, `dnd-5e`, `fate-accelerated`, `ironsworn`.

## Engine: utils/ — Utilities

Platform abstractions and helpers that don't belong to any single domain.

| File | Purpose |
|---|---|
| `archive.ts` | `zipFiles()`, `unzipFiles()` — zip/unzip via `fflate` (pure JS, zero deps). `ArchiveIO` interface, `setArchiveIO()` for test mocking |
| `clipboard.ts` | `ClipboardIO` interface, `copyToClipboard()`, `readFromClipboard()` — cross-platform clipboard via `clipboardy`, lazy-loaded. `setClipboardIO()` for test mocking |
| `paths.ts` | Runtime asset path resolution (prompts, themes, systems relative to executable) |

## Root Files

| File | Purpose |
|---|---|
| `src/app.tsx` | Root Ink component — phase state machine, FileIO/GitIO setup, cost tracking |
| `src/index.tsx` | Entry point — Ink render, raw mode guards |
| `src/shutdown.ts` | Graceful shutdown helper (files, git, terminal) — called by teardown.ts |
| `src/teardown.ts` | Return-to-menu teardown: graceful shutdown + cache reset |
