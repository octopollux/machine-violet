# Machine Violet

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.
Ink (React for CLI) + Anthropic Claude SDK + TypeScript.

## Quick Start

```bash
npm install
npm run check           # lint + tests (run before every PR)
npm run dev             # launch two-tier (needs ANTHROPIC_API_KEY in .env)
```

## Architecture

- **Two-tier: engine server + TUI client** — Fastify HTTP/WS server (`packages/engine`) hosts all game logic; Ink TUI client (`packages/client-ink`) renders the interface. They communicate via REST + WebSocket on localhost. Shared types live in `packages/shared`. A single-process launcher (`scripts/launcher.ts`) starts both for end users.
- **`MachineViolet --server`** — headless mode for network hosting (no TUI, just the API).
- **Filesystem IS the database** — markdown + JSON entities, wikilinked. The campaign transcript is the knowledge backbone; the DM rediscovers things by following wikilinks, not by re-reading its own context.
- **Conversation accumulates within a scene** — exchanges are retained until scene transition clears them. With automatic caching, prior exchanges are read at cache rate. Scene pacing nudges and transition pressure handle long scenes naturally; `max_conversation_tokens` defaults to 0 (disabled) since mid-scene pruning invalidates the prompt cache. Tools return minimum viable information. Delegation to cheap subagents is how you avoid bloating DM context.
- **isomorphic-git** for state snapshots (no system git dependency). Auto-commits happen every N exchanges and at scene/session boundaries.
- **Scene transitions** are idempotent cascades (transcript → summarize → changelog → alarms → context refresh → clear conversation). Each step is safe to re-run; pending operations tracked in `state/pending-operation.json`.

### Execution Tiers

| Tier | Production Model | Used For |
|------|-----------------|----------|
| `large` | Opus | DM narration |
| `medium` | Sonnet | OOC mode, AI players |
| `small` | Haiku | All mechanical subagents (summarizer, precis, changelog, choices, resolve, promotion) |

Configured in `packages/engine/src/config/models.ts`. Override with `dev-config.json`:
```json
{ "models": { "large": "claude-sonnet-4-5-20250929" } }
```
Model config is cached after first load; tests must call `loadModelConfig({ reset: true })`.

## Documentation

All documentation lives in `docs/`. Start at `docs/index.md` for navigation.

- **`docs/`** — Everything: architecture, module map, specifications (tools, subagents, state, context, entities, TUI, etc.), and maintenance guide. Start with `index.md`, see `overview.md` for the spec index.
- **`CLAUDE.md`** (this file) — Conventions and rules for writing code.

### Documentation Maintenance

Code and docs stay in sync. See `docs/maintenance.md` for the full guide.

1. **Before starting work:** check relevant docs (module map, specs) for context.
2. **After changing code:** update any docs affected by the change. See `docs/maintenance.md` for what to update when.
3. **Same commit:** code changes and doc updates go together.
4. **Docs describe what exists.** Planned features go in GitHub issues, not docs. No derived counts.
5. **API schemas stay in sync.** When adding or changing REST endpoints, update the TypeBox schemas in `packages/shared/src/protocol/rest.ts` and wire them into the route's `schema` option — OpenAPI docs are auto-generated from these. When adding or changing WebSocket events, update both `packages/shared/src/protocol/events.ts` and `docs/websocket-api.md`.

## Conventions

### TypeScript & Modules
- `target: ES2022`, `module: nodenext`, `jsx: react-jsx`, `strict: true`. No path aliases.
- **All imports end with `.js`** (ES module resolution requires it).
- Barrel `index.ts` files exist in many directories — check before reaching into subdirectories.
- ESLint flat config (`eslint.config.js`); unused params prefixed with `_` are allowed.

### State & I/O
- **No globals.** All tool handlers take explicit state objects (`GameState`, `DecksState`, `ClocksState`, `CombatState`, `MapData`).
- **FileIO/GitIO interfaces** abstract all I/O. Production uses real `fs`; tests inject mocks. Never call `fs` directly in game logic.
- **GameState** (defined in `packages/engine/src/agents/game-state.ts`) is the single mutable source of truth, passed to every tool handler.
- Tool results use `ok(data)` / `err(message)` helpers. `err` sets `is_error: true`.

### Content Pipeline (`src/content/`)
- **Completely separate from the game engine.** Never import content pipeline code from game code. Filesystem format is the only interface.
- PDF text extraction is local (pdf-parse), not AI. No API calls for extraction.
- Batch API client is retained for the processing pipeline (classifier, extractors).
- Job state and cached pages are persisted to `~/.machine-violet/ingest/`.

### Game Systems (`systems/`)
- Template assets live at the repo root in `systems/<id>/`.
- `metadata.json` — system identity, license, complexity, dice. JSON, not markdown.
- `rule-card.md` — XML-directive format. Dense structured markup for mechanics, prose for guidance. Hand-authored by Opus, human-reviewed.
- At game init, the selected system's template is copied to campaign state.
- Bundled systems must be CC-BY-4.0 compatible (or similarly permissive).

### Entity Filesystem
- **Front matter format:** `**Key:** Value` lines (not YAML). Parsed by `parseFrontMatter()` in `packages/engine/src/tools/filesystem/frontmatter.ts`.
- **Wikilinks are mandatory** — every entity mention in transcripts/logs is a wikilink. Dead links are valid (entity exists in fiction but not yet detailed). Scene summarizer must preserve all wikilinks.
- **Changelogs** are append-only `## Changelog` sections with `- ` entries, updated automatically by Haiku subagent at scene transitions.
- Characters exist on a spectrum: minimal NPCs can be promoted to full character sheets via `promote_character` tool.

### Prompts
- All prompts live in `packages/engine/src/prompts/*.md`, loaded by `loadPrompt(name)` (sync, cached, CRLF→LF normalized).
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
- **Seeded RNG** via `packages/engine/src/tools/dice/rng.ts` — `seededRng(seed)` for determinism, `cryptoRng` for prod.
- **Anthropic client mocked** via `vi.fn()` on `messages.create`. Tests use factory helpers (`textMessage()`, `toolUseMessage()`, etc.) to build fake responses. No real API calls.
- **FileIO mocked** with in-memory `Record<string, string>`.
- **Cross-platform paths:** Tests use `norm()` helper (backslash → forward slash) for all path assertions. Required on Windows.
- **Ink components** tested via `ink-testing-library`: `render(<C />)` → `lastFrame().toContain(...)` (string inspection, no DOM).
- Vitest `globals: true` — `describe`/`it`/`expect` available without import.

### DM Text Formatting Pipeline
- `processNarrativeLines()` in `packages/client-ink/src/tui/formatting.ts` is the single entry point for the rendering pipeline.
- Pipeline: heal raw strings → parse to `FormattingNode[]` AST → wrap (`wrapNodes`) → pad alignment → quote highlight.
- Quote state resets at paragraph boundaries (blank DM lines). All formatting tags (`b`/`i`/`u`/`color`/`center`/`right`) persist across source lines; only real paragraph boundaries (blank DM lines from `\n\n`) reset the tag stack. Visual spacers (from single `\n`) don't reset tags.

### DM Identity (not an assistant)
- The DM decides things, says no, lets bad things happen, has secrets, surprises itself.
- Dice for narrative choices — roll when the story could go several ways, commit to the result.
- Never explain reasoning during narration. NPCs lie, withhold, change their minds.
- The world doesn't revolve around the player. Ticking clocks and alarms drive offscreen events.
- **System-agnostic.** No D&D-specific hardcoding. Initiative, round structure, dice notation are all configurable.

## Cost Awareness

Live API key in `.env` with limited credit. Opus is $5/$25 per MTok. Default dev override uses Sonnet for DM to save money. Don't make unnecessary API calls in manual testing.

## Release & Distribution

- **Release workflow** (`.github/workflows/release.yml`): builds standalone binaries for Windows, macOS, and Linux via `bun build --compile`. Triggered by `v*` tags or `workflow_call` from `cut-release.yml`.
- **Windows signing**: the Windows `.exe` is Authenticode-signed via Azure Trusted Signing (Artifact Signing) using OIDC federation. The workflow runs `azure/login@v2` then `azure/trusted-signing-action@v1`. Infrastructure lives in `../mv-infrastructure/trusted-signing/`.
- **Homebrew tap**: `octopollux/homebrew-mv-tap`. Formula auto-updated by the `update-homebrew` job in the release workflow. Binary + assets install to `libexec` (binary expects `prompts/`, `themes/`, `systems/` next to the executable — see `packages/engine/src/utils/paths.ts`).
- **macOS Gatekeeper**: Homebrew installs bypass Gatekeeper. Direct tarball downloads will trigger quarantine prompts until Apple Developer notarization is set up.
- **Linux**: distributed as a standalone tarball and via Homebrew. No GPG signing or distro packaging currently.

## Commit Hygeine

After completing a coding task, make a detailed commit; you'll need this history later! In your final summary, mention that you have made a commit.

## Code Review

After creating a PR, poll for Copilot code review comments every two minutes for up to ten minutes. Review the feedback and address any issues you judge worthwhile — use your own judgement on what to fix vs skip.