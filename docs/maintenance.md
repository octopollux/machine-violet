# Documentation Maintenance

This project maintains a closed loop between code and documentation. When you change code, update the docs. When you consult docs, trust them — they describe what exists.

## The Loop

```
1. Check docs     → read relevant docs before starting work
2. Make changes   → implement the feature/fix
3. Update docs    → update any docs affected by your changes
4. Commit together → code and doc changes in the same commit
```

## What to Update When

### Adding a new tool

1. Register in `src/agents/tool-registry.ts`
2. Add entry to [tools-catalog.md](tools-catalog.md) in the appropriate domain section
3. If the tool reads/writes state, add to `TOOL_STATE_MAP` in `tool-registry.ts` and update the matrix in [state-atlas.md](state-atlas.md)

### Adding a new subagent

1. Create file in `src/agents/subagents/`
2. Add entry to [subagents-catalog.md](subagents-catalog.md) — include model, visibility, trigger, and source
3. Update the summary table at the bottom of the catalog
4. Add to the subagents section of [docs/module-map.md](module-map.md)

### Adding a new state field

1. Add to the type definition
2. Update the schema tree in [state-atlas.md](state-atlas.md)
3. If persisted, update the persistence map table
4. If it has invariants, add to the invariants catalog

### Adding a new TUI component

1. Create in `src/tui/components/` or `src/tui/modals/`
2. If it's a new modal type, add to [tui-design.md](tui-design.md)
3. Add to the tui section of [docs/module-map.md](module-map.md)

### Changing the scene transition cascade

1. Update step list in [state-atlas.md](state-atlas.md) (section 6)
2. Update the cascade diagram in [docs/architecture.md](architecture.md)

### Adding a new src/ directory or major file

1. Add to [docs/module-map.md](module-map.md)

### Changing model tier assignments

1. Update [subagents-catalog.md](subagents-catalog.md) if it affects a subagent
2. Execution tiers table in [docs/architecture.md](architecture.md) if it changes the tier structure

### Adding a new config field

1. Update the relevant type in `src/types/config.ts`
2. Update [state-atlas.md](state-atlas.md) schema tree

### Changes that DON'T need doc updates

- Bug fixes that don't change interfaces or behavior
- Test additions/changes
- Internal refactors that don't change public APIs
- Comment or formatting changes

## Document Locations

| Document | Path | What it covers |
|---|---|---|
| Architecture overview | [docs/architecture.md](architecture.md) | System architecture mapped to code |
| Module map | [docs/module-map.md](module-map.md) | src/ directory guide |
| Tools catalog | [tools-catalog.md](tools-catalog.md) | Tool signatures and behavior |
| Subagents catalog | [subagents-catalog.md](subagents-catalog.md) | Subagent contracts |
| State atlas | [state-atlas.md](state-atlas.md) | State schema, persistence, invariants, lifecycle |
| Context management | [context-management.md](context-management.md) | Token economics, retention, caching |
| Entity filesystem | [entity-filesystem.md](entity-filesystem.md) | Entity format, wikilinks, changelogs |
| TUI design | [tui-design.md](tui-design.md) | Layout, themes, formatting |
| Conventions | [CLAUDE.md](../CLAUDE.md) | Code style, testing, imports |

## Principles

- **Docs describe what exists.** Planned features live in GitHub issues, not in documentation. If a feature is removed, remove it from docs.
- **No derived counts.** Don't maintain totals of tools, subagents, etc. The canonical list is the list — count the entries if you need a number.
- **Design docs are specs.** They describe data models, contracts, and invariants. `docs/` describes navigation and architecture. `CLAUDE.md` describes conventions. Don't duplicate across layers.
- **Same commit.** Code changes and their doc updates should be in the same commit so they can't drift.
