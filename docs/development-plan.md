# Development Plan

Detailed implementation roadmap for Machine Violet. Organized into phases with clear dependencies. Each phase produces testable, runnable output. Earlier phases have zero AI dependencies — we build and validate the deterministic foundation before wiring up the agent loop.

**Existing scaffolding**: `package.json` (Ink 5, React 18, Claude SDK, tsx, TypeScript 5), `tsconfig.json` (ES2022, strict, JSX), `.env.example`. Branch: `Initial-Code`.

---

## Phase 1: Project Foundation

Get the project building, testing, and linting. No game logic yet.

### 1.1 Dev tooling setup
- [ ] Add test framework: **Vitest** (fast, native ESM/TypeScript, no config hassle)
- [ ] Add test script to `package.json`
- [ ] Add linting: **ESLint** with TypeScript plugin (flat config)
- [ ] Add lint script to `package.json`
- [ ] Create `src/index.tsx` — minimal Ink app that renders "Machine Violet" and exits
- [ ] Verify `npm run dev`, `npm run build`, `npm test`, `npm run lint` all work
- [ ] Create `.gitignore` covering node_modules, dist, .env, *.tsbuildinfo

### 1.2 Source directory structure
```
src/
├── index.tsx                 # entry point
├── app.tsx                   # root Ink component
├── tools/                    # T1 tool implementations
│   ├── dice/
│   ├── cards/
│   ├── maps/
│   ├── clocks/
│   ├── combat/
│   └── filesystem/
├── agents/                   # agent loop, subagent framework
├── tui/                      # Ink components
│   ├── components/           # reusable UI components
│   ├── themes/               # theme assets, parser, color, resolution
│   ├── modals/               # modal system
│   └── layout.tsx            # main layout composition
├── context/                  # context window management
├── config/                   # app config, platform paths
└── types/                    # shared TypeScript types
```

### 1.3 Core types
- [ ] Define shared types in `src/types/`: `Entity`, `Character`, `MapData`, `Clock`, `Alarm`, `DiceResult`, `DeckState`, `CombatState`, `Config`, `ThemeAsset`, `ThemeDefinition`, `ResolvedTheme`
- [ ] Define tool input/output schemas as TypeScript types — these become the contract for agentic output validation

**Tests**: Build compiles, lint passes, test runner works.

---

## Phase 2: Tier 1 Tools

All deterministic, zero AI. The foundation everything else builds on. Each tool module is independently testable.

### 2.1 Dice engine (`src/tools/dice/`)
- [ ] Dice notation parser: `3d6`, `2d20kh1+5`, `4d6kh3`, `3d6!`, `6d10>=7`, `4dF`, multi-expression
- [ ] Roll evaluator with **seeded RNG** (deterministic in tests, crypto random in prod)
- [ ] Player-claimed roll validation (is this result physically possible?)
- [ ] Return schema: `{ expression, rolls[], kept[], modifier, total, reason }`

**Tests**: Every notation variant. Edge cases (0d6, 1d1, exploding chains). Seeded determinism. Claimed roll validation (valid and invalid). Multi-expression parsing.

### 2.2 Card/deck system (`src/tools/cards/`)
- [ ] Deck creation (standard 52, tarot, custom card list)
- [ ] Operations: shuffle (seeded), draw (top/random/bottom), return, peek, state
- [ ] Deck state persistence (JSON serialization/deserialization)
- [ ] Hand management (optional, for systems that use it)

**Tests**: Draw/return/shuffle cycles. Deck exhaustion. State round-trip serialization. Seeded shuffle determinism.

### 2.3 Map system (`src/tools/maps/`)
- [ ] Map data model: sparse coordinate-keyed JSON, regions, entities, annotations, links
- [ ] Terrain resolution: coordinate override → region (last match) → default
- [ ] `map` tool: `create`, `view`, `set_terrain`, `annotate`, `define_region`
- [ ] `map_entity` tool: `place`, `move`, `remove`, `import`, `find_nearest`
- [ ] `map_query` tool: `distance`, `path`, `line_of_sight`, `tiles_in_range`
- [ ] Viewport renderer: text grid + legend output for `map` view
- [ ] Hex grid support (offset coordinates, hex distance, hex adjacency)

**Tests**: Distance calculations (square and hex). Pathfinding (open terrain, obstacles, terrain costs). Line of sight (clear and obstructed). Region overlap resolution. Viewport rendering output. Entity placement/movement/removal. Large map performance (200×200).

### 2.4 Clock system (`src/tools/clocks/`)
- [ ] Clock data model: counter + alarm list
- [ ] Calendar clock: minutes-since-epoch internally, configurable display format
- [ ] Combat round counter: increment, reset
- [ ] Alarm management: set, clear, check, fire
- [ ] Repeating alarms: advance fire_at by interval after firing
- [ ] Display format functions (fantasy, sci-fi, abstract)
- [ ] State persistence (JSON serialization)

**Tests**: Alarm firing at exact threshold. Repeating alarm advancement. Multiple alarms firing in one tick. Calendar display formatting. Round counter reset on combat end. State round-trip.

### 2.5 Combat/initiative system (`src/tools/combat/`)
- [ ] `start_combat`: accept combatants, roll initiative (uses dice engine), sort order
- [ ] `modify_initiative`: add, remove, move, delay
- [ ] `end_combat`: clear order, reset round counter, clear combat alarms
- [ ] Initiative methods: `d20_dex` (reads modifier), `card_draw` (uses deck engine), `fiction_first` (no mechanical order), `custom`
- [ ] Turn order tracking: whose turn is it, advance to next

**Tests**: Initiative sorting. Tie-breaking. Mid-combat modifications. Full combat lifecycle (start → rounds → end). Integration with dice and clock systems.

### 2.6 Entity filesystem helpers (`src/tools/filesystem/`)
- [ ] Campaign directory creation (deterministic folder structure per entity-filesystem.md)
- [ ] Entity file read/write (markdown with front matter)
- [ ] Front matter parser (extract structured fields from entity markdown)
- [ ] Wikilink extraction and validation (find all links in a file, check if targets exist)
- [ ] Changelog appender (add scene-referenced entry to an entity file)
- [ ] Config.json read/write with schema validation
- [ ] Platform-aware home directory detection (Windows Documents, macOS Documents, Linux XDG)

**Tests**: Directory structure creation. Front matter round-trip. Wikilink extraction from various markdown. Dead link detection. Config schema validation. Platform path detection (mock `process.platform`).

### 2.7 Validation suite (`src/tools/filesystem/validation.ts`)
- [ ] Wikilink integrity: every link in campaign log → does the file exist?
- [ ] Character sheet consistency: HP/resource values within valid ranges
- [ ] Map consistency: entities on maps have corresponding character files
- [ ] Clock integrity: alarm fire times in the future, calendar monotonically increasing
- [ ] File format: JSON files are valid JSON, entity files have required front matter

**Tests**: Each validation check with valid and invalid fixtures.

**Phase 2 deliverable**: A library of 37 tool implementations (41 total after TUI additions in later phases), all independently tested, zero AI dependency. This is the largest phase by code volume.

---

## Phase 3: TUI Shell

The visual application. No game logic yet — just the layout rendering with mock data.

### 3.1 Theme system (`src/tui/themes/`)
- [x] Theme asset file format (`.theme`) — INI-like with `[section]` headers and literal ASCII art rows
- [x] Parser: `parseThemeAsset(content) → ThemeAsset`. Validates required components.
- [x] Composition engine: `composeTopFrame`, `composeBottomFrame`, `composeSideColumn`, etc.
- [x] OKLCH color arc generator with built-in presets (`src/tui/color/`)
- [x] Theme resolution: `resolveTheme(definition, variant, keyColor?) → ResolvedTheme`
- [x] Ship 4 built-in themes: gothic, arcane, terminal, clean

### 3.2 Main layout (`src/tui/layout.tsx`)
- [ ] Compose all layout elements: top frame, narrative area, activity line, lower frame, modeline, input, player selector
- [ ] Wire up responsive breakpoints (Full ≥80×40, Narrow, Short, Compact, Minimal ≥20×12)
- [ ] Element drop order logic
- [ ] Left/right frame rendering and drop at ≤40 cols
- [ ] Column responsiveness (modeline truncation, frame simplification)

### 3.3 Core components (`src/tui/components/`)
- [ ] `NarrativeArea` — scrolling text region with formatting tag support
- [ ] `Modeline` — single-line status display
- [ ] `InputLine` — text input with character name prefix
- [ ] `PlayerSelector` — player bar with highlight, AI markers
- [ ] `ActivityLine` — tool-call-to-indicator mapping, glyph fallback
- [ ] `ResourceDisplay` — top frame resource rendering from configurable keys
- [ ] `TurnIndicator` — lower frame centered text with flourish

### 3.4 DM text formatting parser (`src/tui/formatting.ts`)
- [x] Parse tags from DM text output: `<b>`, `<i>`, `<u>`, `<center>`, `<right>`, `<color=#hex>`
- [x] Convert parsed tags to Ink components (`<Text bold>`, `<Text color="#hex">`, `<Box justifyContent>`)
- [x] Strip unrecognized tags. Render malformed tags as plain text.
- [x] Nested tags
- [x] AST-based pipeline: `processNarrativeLines` (heal → parse → wrap → pad → quote highlight)
- [x] Paragraph-scoped quote reset (blank DM lines reset quote state)

**Tests**: Every tag type. Nesting. Malformed input. Unrecognized tags. Empty content. AST wrapping. Cross-line healing. Quote paragraph reset.

### 3.5 Modal system (`src/tui/modals/`)
- [ ] Base modal component: themed border (inherits active style variant), overlay behavior, dismiss handling
- [ ] `CharacterSheetModal` — render entity markdown as styled modal
- [ ] `ChoiceModal` — prompt + labeled options (A/B/C) + freeform input
- [ ] `DiceRollModal` — dramatic roll display
- [ ] `SessionRecapModal` — "Previously on..." text display
- [ ] `GameMenuModal` — ESC menu with navigation (Resume, Character Sheet, OOC, Settings, Save & Quit)
- [ ] Modal stacking (game menu over gameplay, character sheet from game menu)

### 3.6 Demo mode
- [ ] Wire layout with hardcoded mock data (mock narrative, mock modeline, mock resources)
- [ ] Hotkeys for cycling themes and variants
- [ ] Resize handler demonstrating responsive breakpoints

**Tests**: Formatting parser (unit). Frame renderer output (unit). Responsive breakpoint logic (unit). Component rendering with ink-testing-library.

**Phase 3 deliverable**: A running Ink app you can launch and see the full TUI with mock data. Style switching, responsive resize, modals, formatting all work visually.

---

## Phase 4: Agent Core

Wire up the Claude SDK. First time we talk to an API.

### 4.1 Tool registry (`src/agents/tool-registry.ts`)
- [ ] Tool definition format matching Claude API tool_use schema
- [ ] Register all T1 tools from Phase 2 as callable tools
- [ ] Tool dispatch: receive tool_use block from API → route to implementation → return result
- [ ] Tool result formatting: terse output per context-management.md guidelines

### 4.2 Agent loop (`src/agents/agent-loop.ts`)
- [ ] Core conversation loop: send messages → receive response → handle tool_use → loop
- [ ] Streaming support: DM narration streams to the TUI as it generates
- [ ] API error handling: retry with exponential backoff, sustained outage detection
- [ ] Tool call → activity indicator mapping (fire TUI updates during tool execution)

### 4.3 Context window manager (`src/context/`)
- [ ] Cached prefix builder: system prompt + tool defs + rules + campaign summary + session recap + active state + scene precis
- [ ] Conversation retention: keep last N exchanges, drop oldest
- [ ] Token counting (estimate or API-reported)
- [ ] Tool result stubbing: replace full results with one-line stubs after N exchanges
- [ ] `max_conversation_tokens` hard cap enforcement
- [ ] Precis update trigger: when an exchange drops, flag for Haiku summarization

### 4.4 Subagent framework (`src/agents/subagent.ts`)
- [ ] Spawn a nested Claude API conversation with its own system prompt and context
- [ ] Silent mode: run, return result to caller, player sees nothing
- [ ] Player-facing mode: temporarily redirect TUI input/output to the subagent
- [ ] Terse return enforcement: subagent prompt includes "respond in minimum tokens"
- [ ] Prompt caching: front-load stable context (rules) into subagent system prompts

**Tests**: Tool registry dispatch (mock tools). Context window pruning logic (unit). Tool result stubbing (unit). Subagent framework with mocked API responses.

**Phase 4 deliverable**: The app can have a basic conversation with Claude. Tools are callable. Context is managed. Subagents can be spawned.

---

## Phase 5: Core Game Loop

Connect the agent to the game. The DM can narrate, use tools, and manage scenes.

### 5.1 DM system prompt assembly
- [ ] Load DM prompt from dm-prompt.md template
- [ ] Inject DM personality fragment from config
- [ ] Inject game system rules appendix (distilled cards if available)
- [ ] Build the full cached prefix per context-management.md layout

### 5.2 Scene/session management (`src/agents/scene-manager.ts`)
- [ ] `scene_transition` cascade: finalize transcript → campaign log entry (Haiku) → entity changelog updates (Haiku) → advance calendar → check alarms → reset precis → prune context → git checkpoint
- [ ] Idempotent step tracking: `pending-operation.json` marker for mid-cascade recovery
- [ ] `session_end`: final scene transition + session recap (Haiku)
- [ ] `session_resume`: load campaign state, build prefix, display recap modal, start DM
- [ ] Transcript writing: append player input + DM response + tool results to scene transcript file, wikilinked

### 5.3 First subagents
- [ ] **Scene summarizer**: Haiku writes campaign log entry from completed transcript
- [ ] **Precis updater**: Haiku appends terse summary when exchange drops from conversation
- [ ] **Changelog updater**: Haiku scans transcript, appends entries to entity files
- [x] **ResolveSession**: Sonnet-tier persistent combat resolver. Accumulates context across turns, returns structured StateDelta[].

### 5.4 Wire TUI to agent loop
- [ ] Player input → tagged message `[CharName] text` → agent loop
- [ ] DM response → formatting parser → narrative area
- [ ] Tool calls → activity indicators
- [ ] Tool results → modeline updates, style changes, etc.
- [ ] Modals triggered by tool calls (present_choices, show_character_sheet)

**Tests**: Scene transition cascade (mock Haiku, verify all steps fire). Transcript writing format. Pending operation recovery. ResolveSession return schema validation.

**Phase 5 deliverable**: A playable game loop. The DM narrates, the player responds, tools work, scenes transition, context is managed. Single player, no init flow yet — campaign directory is manually created or scaffolded by a test helper.

---

## Phase 6: Game Initialization

The setup flow that takes a player from first launch to gameplay.

### 6.1 First launch (`src/config/first-launch.ts`)
- [ ] API key prompt (centered TUI, validates with test API call)
- [ ] Home directory prompt (platform default displayed, custom path option)
- [ ] Save to `.env` and `config.json`
- [ ] Skip if already configured

### 6.2 Main menu (`src/tui/main-menu.tsx`)
- [ ] "Start a new campaign" / "Continue a campaign" / "Just jump in"
- [ ] Continue: list existing campaign directories, pick one → `session_resume`
- [ ] Start / Just jump in → setup agent

### 6.3 Setup agent (`src/agents/setup-agent.ts`)
- [ ] Sonnet-powered conversational setup with dramatic personality
- [ ] Structured choices (3-5 options + freeform) at each step using choice modal
- [ ] Full flow: genre → system → campaign source → mood → difficulty → DM personality → player info → character
- [ ] "Just jump in" fast path: 4 prompts, Enter = random at each
- [ ] Campaign seeds: shipped list, genre-tagged, randomly sampled for suggestions
- [ ] DM personality selection: shipped fragments + custom option

### 6.4 World building cascade
- [ ] Create campaign directory structure
- [ ] Write config.json (system, mood, difficulty, calendar format, context settings, choice frequency)
- [ ] Initialize clocks (calendar epoch, display format)
- [ ] Write rule files (if system selected, from rules-cache or import)
- [ ] Build starting location (index file, optional map)
- [ ] Create initial NPCs
- [ ] Write campaign log (first entry)
- [ ] Write party file
- [ ] Generate distilled rule cards (Haiku) if crunchy system

### 6.5 Character creation
- [ ] Freeform: conversational (part of Sonnet setup flow)
- [ ] Crunchy: delegate to Haiku chargen subagent (player-facing)
- [ ] Write character file with display_resources set
- [ ] Handoff to DM: build cached prefix, start Opus agent loop, first narration

### 6.6 Rules fetching
- [ ] Fetch free SRDs at runtime (URL list shipped with app)
- [ ] Cache to `rules-cache/` in home directory
- [ ] Haiku parses into rule files + distilled cards

**Tests**: Campaign directory structure creation. Config schema. Platform path defaults. Fast path flow (mock Sonnet).

**Phase 6 deliverable**: Complete path from `npm run dev` to gameplay. New players can start a game. Returning players can resume.

---

## Phase 7: Document Ingestion

PDF import pipeline. Can be deferred if needed — the game works without it.

### 7.1 PDF extraction
- [ ] PDF page rendering/text extraction (pdf.js or similar)
- [ ] Heuristic: clean text extraction vs vision fallback
- [ ] Haiku vision extraction for complex layouts
- [ ] Per-page structured markdown output

### 7.2 Organization and indexing
- [ ] Haiku sorts extracted content into entity filesystem
- [ ] Cross-reference → wikilink conversion
- [ ] Table of contents generation
- [ ] DM cheat sheet generation (campaign books)
- [ ] Distilled rule card generation (rulebooks)

### 7.3 Batch API support
- [ ] JSONL serialization of extraction requests
- [ ] Batch submission via Anthropic Batch API
- [ ] `pending-import.json` marker
- [ ] Background polling (~5 min timer)
- [ ] Resume on app startup if pending

### 7.4 Import UX
- [ ] Cost estimate before starting (based on page count)
- [ ] Normal vs batch choice
- [ ] Progress indicator
- [ ] Incremental import (subset of pages)

**Tests**: Extraction output format (mock vision responses). Organization file routing. Wikilink conversion. Batch JSONL format.

---

## Phase 8: Multiplayer & AI Players

### 8.1 Hot-seat multiplayer
- [ ] Player registry in config (human and AI players)
- [ ] Player bar component with active highlighting
- [ ] Tab to switch active player (outside initiative)
- [ ] Automatic player switching during initiative
- [ ] Input tagging per active player

### 8.2 AI players
- [ ] AI player prompt template (personality + character sheet summary + recent context)
- [ ] Haiku/Sonnet call replacing human input on AI player's turn
- [ ] Output fed into agent loop as `[CharName] action text`
- [ ] Configurable model per AI player

### 8.3 OOC mode
- [ ] `enter_ooc` tool: snapshot DM context, switch to Sonnet subagent, TUI style change
- [ ] OOC subagent: access to filesystem, validation suite, rollback, config
- [ ] Exit: terse summary returned to DM, TUI style reverts
- [ ] Trigger from game menu or DM detecting OOC player input

**Tests**: Player switching logic. AI player prompt construction. OOC entry/exit lifecycle.

---

## Phase 9: Error Recovery & Git

### 9.1 isomorphic-git integration
- [ ] Initialize git repo in campaign directory
- [ ] Auto-commit: every N exchanges, scene transitions, session end, before destructive ops
- [ ] Commit message format: `auto:`, `scene:`, `session:`, `checkpoint:`, `character:`
- [ ] Commit pruning: cap at max_commits, preserve scene/session commits

### 9.2 Rollback
- [ ] `rollback` tool: find commit by label/hash/"last"/exchanges_ago, restore files
- [ ] Post-rollback: trigger `session_resume` with restored state
- [ ] Git log with human-readable labels for OOC "show save history"

### 9.3 Mid-cascade recovery
- [ ] `pending-operation.json` written at cascade start
- [ ] On app launch: detect pending operations, resume from last completed step
- [ ] Each cascade step is idempotent

**Tests**: Auto-commit triggers. Rollback to specific commits. Pending operation resume. Idempotent step re-execution.

---

## Phase 10: Polish & Packaging Prep

### 10.1 Cost monitoring
- [ ] Token tracking per turn (input, cached, output)
- [ ] Running session cost estimate
- [ ] Optional display in settings/OOC

### 10.2 Choice auto-generation
- [ ] Engine detects "player's turn" after DM narration
- [ ] Checks frequency config (campaign default + player override)
- [ ] Fires Haiku subagent with recent context
- [ ] Explicit DM choices take precedence

### 10.3 Character promotion
- [ ] `promote_character` tool wired to Haiku subagent
- [ ] Reads game system rules + existing notes + DM context
- [ ] Writes/updates character file, preserves changelog

### 10.4 Edge cases and polish
- [ ] Responsive breakpoint testing at actual terminal sizes
- [ ] ESC game menu full functionality (all options wired)
- [ ] Settings modal: choice frequency, display prefs
- [ ] API key rotation without app restart
- [ ] Graceful shutdown (save state on SIGINT/SIGTERM)

### 10.5 Packaging preparation
- [ ] Audit dependencies for native addons (should be none)
- [ ] Verify all path handling uses `path.join` / platform-aware logic
- [ ] Test on Windows, macOS, Linux
- [ ] Document packaging options (pkg, caxa, Node SEA) for future implementation

**Phase 10 deliverable**: Production-ready application. All features working, tested, cross-platform verified.

---

## Dependency Graph

```
Phase 1 (Foundation)
  ↓
Phase 2 (T1 Tools) ──────────────────┐
  ↓                                    ↓
Phase 3 (TUI Shell)              Phase 4 (Agent Core)
  ↓                                    ↓
  └──────────────┬─────────────────────┘
                 ↓
           Phase 5 (Core Game Loop)
                 ↓
           Phase 6 (Game Init)
                 ↓
     ┌───────────┼───────────┐
     ↓           ↓           ↓
  Phase 7    Phase 8     Phase 9
  (Import)   (Multi)    (Git/Recovery)
     └───────────┼───────────┘
                 ↓
           Phase 10 (Polish)
```

Phases 2 and 3 can be developed in parallel (tools vs TUI). Phases 3 and 4 converge in Phase 5. Phases 7, 8, 9 are independent of each other and can be parallelized.

---

## Testing Strategy

| Layer | Framework | Approach |
|---|---|---|
| T1 tools | Vitest | Unit tests with seeded RNG. Full coverage of every tool. |
| TUI components | ink-testing-library | Component rendering, responsive behavior. |
| Formatting parser | Vitest | Unit tests for every tag, nesting, edge cases. |
| Agent loop | Vitest + mock API | Mock Claude responses. Verify tool dispatch, context pruning. |
| Subagent outputs | Vitest + schema validation | Validate return shapes, value bounds, consistency. Real API optional for integration tests. |
| Scene cascades | Vitest | Mock subagents, verify all steps fire, idempotent re-execution. |
| Filesystem | Vitest + temp dirs | Write/read/validate entity files in temporary campaign directories. |
| E2E | Manual + scripted | Full game sessions. Cost tracking. Cross-platform verification. |
