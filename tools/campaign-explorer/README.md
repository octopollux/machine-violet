# Campaign Explorer

Real-time web viewer for Machine Violet campaign data. Browse entity files, state JSON, transcripts, and context dumps as they're written during gameplay.

## Quick Start

```bash
cd tools/campaign-explorer
npm install
npm run dev:server   # Express API on :3999
npm run dev:client   # Vite dev server on :5199 (proxies /api to :3999)
```

Open http://localhost:5199 in your browser.

## Campaign Discovery

The server finds campaigns in this order:

1. `--campaigns-dir <path>` CLI argument
2. `campaigns_dir` from the main app's `config.json`
3. Platform default: `~/Documents/.machine-violet/campaigns`

Each subdirectory containing a `config.json` is treated as a campaign.

## Architecture

```
Browser ←─ SSE (file-change events) ─── Express server
Browser ──→ REST (tree, file content) ─→ Express server
                                              │
                                        chokidar watchers
                                              │
                                        campaign directories
```

- **SSE** pushes `file-change` events on create/modify/delete (200ms debounce)
- **REST API** serves campaign list, file tree, and file content on demand
- **Vite** proxies `/api` to the Express server during development

## File Categories

Files are automatically categorized in the sidebar:

| Category | Matches |
|----------|---------|
| Config | `config.json` |
| State | `state/*.json` |
| Transcript | `campaign/scenes/*/transcript.md`, session recaps, campaign log |
| Entity | `characters/`, `locations/`, `factions/`, `lore/`, `rules/`, `players/` |
| Context Dump | `context-dump/*.json` (not thinking) |
| Thinking | `context-dump/*-thinking.json` |
| Map | `*map*.json` |
| Other | Everything else |

## Viewers

- **Markdown** — renders frontmatter as a table, clickable `[[wikilinks]]`, inline color swatches for hex codes
- **JSON** — syntax-colored, collapsible objects/arrays, color swatches
- **Context Dump** — system prompt as markdown, messages as colored blocks by role, `_thinking_trace` entries in italics, collapsible tool definitions

## Timeline (flame chart)

The **Timeline** nav item (top of the sidebar) is a *time-based* view, not a file view. It reads the engine's span trace (`../.debug/trace.jsonl`) and renders every turn of the selected campaign as a segmented flame chart, left→right in chronological order:

- Each turn is a column whose width is proportional to its wall-clock duration; within it, spans are laid out as a time-ordered icicle (x = time offset, y = nesting depth).
- Colours encode span kind: `turn` / `agent` / `api_call` / `tool` / `image_gen` / `background`. Parallel tool calls show as overlapping sibling bars; a subagent shows as a nested `agent → api_call` subtree. Errors are tinted red.
- Hover any bar for duration, model, token counts, stop reason, retry attempts, and image effort/aspect.
- `−` / `+` zoom the time scale; the view refreshes on SSE `trace.jsonl` changes with a slow poll backstop.

This answers "what took the time in this two-minute turn?" — see [state-atlas.md](../../docs/state-atlas.md) §9 (Span Trace) for the on-disk model. Served by `GET /api/engine-log/spans?campaign=<slug>&limit=<n>`.

## Features

- **Update dots** — green indicator on files/categories/campaigns that changed since last viewed
- **Auto-follow** — per-category toggle that auto-selects the most recently changed file
- **Auto-scroll** — content pane scrolls to bottom when new content arrives (if already near bottom)
- **Wikilink navigation** — clicking a `[[wikilink]]` in markdown jumps to the matching entity file

## Contract Tests

```bash
npm test
```

Tests in `tests/contract/` import directly from the main codebase (`../../src/...`) and validate that the data shapes the explorer depends on haven't changed. If the main app modifies `STATE_FILES`, `campaignDirs()`, `parseFrontMatter()`, or the context dump envelope, these tests break as an early warning.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev:server` | Start Express with tsx watch |
| `npm run dev:client` | Start Vite dev server |
| `npm run dev` | Start both (background server + Vite) |
| `npm run build` | Production Vite build + typecheck |
| `npm test` | Run contract tests |
| `npm run typecheck` | Check both client and server TypeScript |
