# Machine Violet Documentation

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.
Ink (React for CLI) + Anthropic Claude SDK + TypeScript.

## Quick Navigation

| I need to... | Go to |
|---|---|
| Understand the system architecture | [architecture.md](architecture.md) |
| Find where code lives | [module-map.md](module-map.md) |
| Look up a tool's signature or behavior | [tools-catalog.md](tools-catalog.md) |
| Look up a subagent's contract | [subagents-catalog.md](subagents-catalog.md) |
| Understand state shape and persistence | [state-atlas.md](state-atlas.md) |
| Construct or validate a campaign on disk | [format-spec.md](format-spec.md) |
| Understand context window management | [context-management.md](context-management.md) |
| Understand entity files and wikilinks | [entity-filesystem.md](entity-filesystem.md) |
| Understand DM text formatting | [tui-design.md](tui-design.md) |
| Understand clocks, alarms, calendar | [clocks-and-alarms.md](clocks-and-alarms.md) |
| Understand maps and spatial queries | [map-system.md](map-system.md) |
| Understand dice, cards, resolution | [randomization.md](randomization.md) |
| Understand combat and initiative | [multiplayer-and-initiative.md](multiplayer-and-initiative.md) |
| Understand DM identity and prompting | [dm-prompt.md](dm-prompt.md) |
| Understand game setup flow | [game-initialization.md](game-initialization.md) |
| Understand game systems and rule cards | [rules-systems.md](rules-systems.md) |
| Understand PDF import and content processing | [document-ingestion.md](document-ingestion.md) |
| Understand error recovery and git | [error-recovery.md](error-recovery.md) |
| Look up REST API contracts (auto-generated) | `/docs` endpoint (Scalar UI) or `/docs/json` (OpenAPI spec) |
| Look up WebSocket event contracts | [websocket-api.md](websocket-api.md) |
| Update documentation after a code change | [maintenance.md](maintenance.md) |

## Document Layers

This project has three documentation layers. Each has a distinct purpose:

**Navigation & architecture** — [index.md](index.md), [architecture.md](architecture.md), [module-map.md](module-map.md). Start here to find what you need.

**Specifications** — The rest of this directory: data models, invariants, tool contracts, subagent protocols. The canonical reference for "how does X work?" Start with [overview.md](overview.md) for the full index.

**[CLAUDE.md](../CLAUDE.md)** — Conventions. Rules for writing code in this project: imports, testing, state management, formatting. The canonical reference for "how should I do X?"

All docs describe only what is implemented. Planned features live in GitHub issues, not in documentation.

## Running the Project

```bash
npm install
npm run check           # lint + tests (run before every PR)
npm run dev             # launch two-tier (needs ANTHROPIC_API_KEY in .env)
```
