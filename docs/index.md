# tui-rpg Documentation

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.
Ink (React for CLI) + Anthropic Claude SDK + TypeScript.

## Quick Navigation

| I need to... | Go to |
|---|---|
| Understand the system architecture | [architecture.md](architecture.md) |
| Find where code lives | [module-map.md](module-map.md) |
| Look up a tool's signature or behavior | [design-docs/tools-catalog.md](../design-docs/tools-catalog.md) |
| Look up a subagent's contract | [design-docs/subagents-catalog.md](../design-docs/subagents-catalog.md) |
| Understand state shape and persistence | [design-docs/state-atlas.md](../design-docs/state-atlas.md) |
| Understand context window management | [design-docs/context-management.md](../design-docs/context-management.md) |
| Understand entity files and wikilinks | [design-docs/entity-filesystem.md](../design-docs/entity-filesystem.md) |
| Understand DM text formatting | [design-docs/tui-design.md](../design-docs/tui-design.md) |
| Understand clocks, alarms, calendar | [design-docs/clocks-and-alarms.md](../design-docs/clocks-and-alarms.md) |
| Understand maps and spatial queries | [design-docs/map-system.md](../design-docs/map-system.md) |
| Understand dice, cards, resolution | [design-docs/randomization.md](../design-docs/randomization.md) |
| Understand combat and initiative | [design-docs/multiplayer-and-initiative.md](../design-docs/multiplayer-and-initiative.md) |
| Understand DM identity and prompting | [design-docs/dm-prompt.md](../design-docs/dm-prompt.md) |
| Understand game setup flow | [design-docs/game-initialization.md](../design-docs/game-initialization.md) |
| Understand error recovery and git | [design-docs/error-recovery.md](../design-docs/error-recovery.md) |
| Update documentation after a code change | [maintenance.md](maintenance.md) |

## Document Layers

This project has three documentation layers. Each has a distinct purpose:

**[docs/](.)** — Navigation and discovery. Start here to find what you need. Maps concepts to code, describes how modules connect.

**[design-docs/](../design-docs/)** — Specifications. Detailed descriptions of each subsystem: data models, invariants, tool contracts, subagent protocols. The canonical reference for "how does X work?" Start with [design-docs/overview.md](../design-docs/overview.md) for the full index.

**[CLAUDE.md](../CLAUDE.md)** — Conventions. Rules for writing code in this project: imports, testing, state management, formatting. The canonical reference for "how should I do X?"

All three layers describe only what is implemented. Planned features live in GitHub issues, not in documentation.

## Running the Project

```bash
npm install
npm run check           # lint + tests + coverage (run before every PR)
npx tsx src/index.tsx    # launch (needs ANTHROPIC_API_KEY in .env)
```
