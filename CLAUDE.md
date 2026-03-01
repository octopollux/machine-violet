# TUI-RPG

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.
Ink (React for CLI) + Anthropic Claude SDK + TypeScript.

## Quick Start

```bash
npm install
npm run check           # lint + tests + coverage threshold (run before every PR)
npx tsx src/index.tsx    # launch (needs ANTHROPIC_API_KEY in .env)
```

## Architecture

- **Single Ink process** — no frontend/backend split. DM tools manipulate UI directly.
- **Filesystem IS the database** — markdown + JSON entities, wikilinked. The campaign transcript is the knowledge backbone; the DM rediscovers things by following wikilinks, not by re-reading its own context.
- **Conversation is ephemeral** — kept to 3-5 exchanges, then dropped and compressed into a scene precis in the cached prefix. Tools return minimum viable information. Delegation to cheap subagents is how you avoid bloating DM context.
- **isomorphic-git** for state snapshots (no system git dependency). Auto-commits happen every N exchanges and at scene/session boundaries.
- **Scene transitions** are idempotent cascades (transcript → summarize → changelog → alarms → context refresh → clear conversation). Each step is safe to re-run; pending operations tracked in `state/pending-operation.json`.

### Execution Tiers

| Tier | Production Model | Used For |
|------|-----------------|----------|
| `large` | Opus | DM narration |
| `medium` | Sonnet | OOC mode, AI players |
| `small` | Haiku | All mechanical subagents (summarizer, precis, changelog, choices, resolve, promotion) |

Configured in `src/config/models.ts`. Override with `dev-config.json`:
```json
{ "models": { "large": "claude-sonnet-4-5-20250929" } }
```
Model config is cached after first load; tests must call `loadModelConfig({ reset: true })`.

## Design Docs

All in `design-docs/`. Start with `overview.md` — it links to everything else.
Key docs: `tools-catalog.md`, `subagents-catalog.md`, `development-plan.md`, `tui-design.md`, `dm-prompt.md`, `context-management.md`, `entity-filesystem.md`.

## Conventions

### TypeScript & Modules
- `target: ES2022`, `module: nodenext`, `jsx: react-jsx`, `strict: true`. No path aliases.
- **All imports end with `.js`** (ES module resolution requires it).
- Barrel `index.ts` files exist in many directories — check before reaching into subdirectories.
- ESLint flat config (`eslint.config.js`); unused params prefixed with `_` are allowed.

### State & I/O
- **No globals.** All tool handlers take explicit state objects (`GameState`, `DecksState`, `ClocksState`, `CombatState`, `MapData`).
- **FileIO/GitIO interfaces** abstract all I/O. Production uses real `fs`; tests inject mocks. Never call `fs` directly in game logic.
- **GameState** (defined in `src/agents/game-state.ts`) is the single mutable source of truth, passed to every tool handler.
- Tool results use `ok(data)` / `err(message)` helpers. `err` sets `is_error: true`.

### Entity Filesystem
- **Front matter format:** `**Key:** Value` lines (not YAML). Parsed by `parseFrontMatter()` in `src/tools/filesystem/frontmatter.ts`.
- **Wikilinks are mandatory** — every entity mention in transcripts/logs is a wikilink. Dead links are valid (entity exists in fiction but not yet detailed). Scene summarizer must preserve all wikilinks.
- **Changelogs** are append-only `## Changelog` sections with `- ` entries, updated automatically by Haiku subagent at scene transitions.
- Characters exist on a spectrum: minimal NPCs can be promoted to full character sheets via `promote_character` tool.

### Prompts
- All prompts live in `src/prompts/*.md`, loaded by `loadPrompt(name)` (sync, cached, CRLF→LF normalized).
- Templates use `{{placeholder}}` interpolation via `loadTemplate(name, vars)`.
- `postbuild` script copies `.md` files to `dist/prompts/` for runtime access.
- **Tests must call `resetPromptCache()` in `beforeEach`** to avoid cross-test pollution.

### Subagents
- `spawnSubagent()` creates an isolated Claude conversation with its own context window — DM context is never polluted.
- System prompts automatically get a suffix enforcing terse responses.
- Subagents have own `maxToolRounds` (default 3) and return usage stats.
- **Delegation is not optional** — never have the DM do mechanical work a Haiku subagent can do.

### Testing
- Tests are **co-located** with source (e.g., `foo.ts` + `foo.test.ts`).
- **Seeded RNG** via `src/tools/dice/rng.ts` — `seededRng(seed)` for determinism, `cryptoRng` for prod.
- **Anthropic client mocked** via `vi.fn()` on `messages.create`. Tests use factory helpers (`textMessage()`, `toolUseMessage()`, etc.) to build fake responses. No real API calls.
- **FileIO mocked** with in-memory `Record<string, string>`.
- **Cross-platform paths:** Tests use `norm()` helper (backslash → forward slash) for all path assertions. Required on Windows.
- **Ink components** tested via `ink-testing-library`: `render(<C />)` → `lastFrame().toContain(...)` (string inspection, no DOM).
- Vitest `globals: true` — `describe`/`it`/`expect` available without import.

### DM Text Formatting Pipeline
- `processNarrativeLines()` in `src/tui/formatting.ts` is the single entry point for the rendering pipeline.
- Pipeline: heal raw strings → parse to `FormattingNode[]` AST → wrap (`wrapNodes`) → pad alignment → quote highlight.
- Quote state resets at paragraph boundaries (blank DM lines). `b`/`i`/`u` persist across source lines; `color` resets.

### DM Identity (not an assistant)
- The DM decides things, says no, lets bad things happen, has secrets, surprises itself.
- Dice for narrative choices — roll when the story could go several ways, commit to the result.
- Never explain reasoning during narration. NPCs lie, withhold, change their minds.
- The world doesn't revolve around the player. Ticking clocks and alarms drive offscreen events.
- **System-agnostic.** No D&D-specific hardcoding. Initiative, round structure, dice notation are all configurable.

## Cost Awareness

Live API key in `.env` with limited credit. Opus is $5/$25 per MTok. Default dev override uses Sonnet for DM to save money. Don't make unnecessary API calls in manual testing.

## Commit Hygeine

After completing a coding task, make a detailed commit; you'll need this history later! In your final summary, mention that you have made a commit.