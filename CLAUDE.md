# TUI-RPG

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.
Ink (React for CLI) + Anthropic Claude SDK + TypeScript.

## Quick Start

```bash
npm install
npx vitest run          # 491 tests
npx eslint src/         # lint
npx tsx src/index.tsx    # launch (needs ANTHROPIC_API_KEY in .env)
```

## Architecture

- **Single Ink process** — no frontend/backend split. DM tools manipulate UI directly.
- **Filesystem IS the database** — markdown + JSON entities, wikilinked, campaign transcript is the knowledge backbone.
- **isomorphic-git** for state snapshots (no system git dependency).
- **Context window is aggressively managed**: small conversation window (3-5 exchanges), cached prefix for stable knowledge, scene precis for continuity.

### Execution Tiers

| Tier | Production Model | Used For |
|------|-----------------|----------|
| `large` | Opus | DM narration |
| `medium` | Sonnet | OOC mode, AI players (sonnet tier) |
| `small` | Haiku | Summarizer, precis, changelog, choices, resolve, promotion |

Configured in `src/config/models.ts`. Override with `dev-config.json` (gitignored):
```json
{ "models": { "large": "claude-sonnet-4-5-20250929" } }
```

## Source Layout

```
src/
  agents/           # Agent loop, game engine, DM prompt, scene manager, setup, player manager
    subagents/      # 8 subagent patterns: summarizer, precis, changelog, choices, resolve, promotion, ooc, ai-player
  config/           # First launch, main menu, model tiers, personalities, seeds
  context/          # Conversation manager, cost tracker
  tools/            # T1 tool implementations (dice, cards, maps, clocks, combat, filesystem, git, validation)
  tui/              # Ink components: layout, frames, formatting, modals, responsive, activity
  types/            # Shared type definitions (config, tui, dice, etc.)
  app.tsx            # Root Ink component — app state machine (7 phases)
  index.tsx          # Entry point — signal handlers, Ink render
  shutdown.ts        # Graceful shutdown (flush transcript, git commit)
```

## Design Docs

All in `design-docs/`. Start with `overview.md` — it links to everything else.

Key docs: `tools-catalog.md` (37 tools), `subagents-catalog.md` (14 patterns), `development-plan.md` (10-phase roadmap), `tui-design.md` (layout/frames/modals), `dm-prompt.md` (system prompt engineering).

## Conventions

- **No globals.** All T1 tools take explicit state objects (DecksState, ClocksState, CombatState, MapData).
- **System-agnostic.** No D&D-specific hardcoding. Initiative, round structure, dice notation are all configurable.
- **Tests use seeded RNG** via `src/tools/dice/rng.ts` (LCG for tests, crypto for prod).
- **Cross-platform paths.** Tests use `norm()` helper (backslash → forward slash) for assertions.
- **Front matter format:** `**Key:** Value` lines (not YAML).
- **Agent loop mocked in tests** via fake Anthropic client (`vi.fn` on `messages.create`/`stream`). No real API calls in tests.
- **Subagents** enforce "respond in minimum tokens" via system prompt suffix.
- **GitIO/FileIO interfaces** abstract I/O for testable mocking.
- **Validation errors** use severity levels: `"error"` vs `"warning"`.

## Cost Awareness

Live API key in `.env` with limited credit. Opus is $5/$25 per MTok. Default dev override uses Sonnet for DM to save money. Don't make unnecessary API calls in manual testing.

## TypeScript Config

`target: ES2022`, `module: nodenext`, `jsx: react-jsx`, `strict: true`.

ESLint uses flat config (`eslint.config.js`) with `typescript-eslint`.
