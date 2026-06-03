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

1. Register in `packages/engine/src/agents/tool-registry.ts`
2. Add entry to [tools-catalog.md](tools-catalog.md) in the appropriate domain section
3. If the tool reads/writes state, add to `TOOL_STATE_MAP` in `tool-registry.ts` and update the matrix in [state-atlas.md](state-atlas.md)

### Adding a new subagent

1. Create file in `packages/engine/src/agents/subagents/`
2. Add entry to [subagents-catalog.md](subagents-catalog.md) — include model, visibility, trigger, and source
3. Update the summary table at the bottom of the catalog
4. Add to the subagents section of [docs/module-map.md](module-map.md)

### Adding a new state field

1. Add to the type definition
2. Update the schema tree in [state-atlas.md](state-atlas.md)
3. If persisted, update the persistence map table
4. If it has invariants, add to the invariants catalog

### Adding a new TUI component

1. Create in `packages/client-ink/src/tui/components/` or `packages/client-ink/src/tui/modals/`
2. If it's a new modal type, add to [tui-design.md](tui-design.md)
3. Add to the tui section of [docs/module-map.md](module-map.md)

### Changing the scene transition cascade

1. Update step list in [state-atlas.md](state-atlas.md) (section 6)
2. Update the cascade diagram in [docs/architecture.md](architecture.md)

### Adding a new package directory or major file

1. Add to [docs/module-map.md](module-map.md)

### Changing model tier assignments

1. Update [subagents-catalog.md](subagents-catalog.md) if it affects a subagent
2. Execution tiers table in [docs/architecture.md](architecture.md) if it changes the tier structure

### Adding a new config field

1. Update the relevant type in `packages/shared/src/types/config.ts`
2. Update [state-atlas.md](state-atlas.md) schema tree

### Adding or changing a REST endpoint

1. Define request/response TypeBox schemas in `packages/shared/src/protocol/rest.ts`
2. Wire schemas into the Fastify route's `schema` option (`body`, `params`, `querystring`, `response`)
3. OpenAPI docs update automatically via `@fastify/swagger` — no manual doc edit needed

### Adding or changing a WebSocket event

1. Define the event schema in `packages/shared/src/protocol/events.ts`
2. Add to the `ServerEvent` union type
3. Update [websocket-api.md](websocket-api.md) with the new event type, payload fields, and when it fires

### Adding a new LLM provider

1. Create the adapter under `packages/engine/src/providers/<provider-id>/` implementing `LLMProvider`
2. Add the provider id to the `ProviderType` union in `packages/engine/src/config/connections.ts`
3. Wire the construction case in `createProviderFromConnection` in `packages/engine/src/providers/index.ts`
4. Add tier defaults under the provider's connection-type key in `packages/engine/src/config/known-models.json`
5. If the provider's connection-type maps to an existing model family (e.g. both `openai-apikey` and `openai-chatgpt` reach the `openai` family), update `modelFamilyFor` in `packages/engine/src/config/model-registry.ts`
6. Add the provider id to the `AddConnectionRequest` literal union in `packages/shared/src/protocol/rest.ts` and to `VALID_PROVIDERS` in `packages/engine/src/server/routes/management.ts`
7. Add it to `PROVIDER_OPTIONS` in `packages/client-ink/src/phases/ConnectionsPhase.tsx` (or, for OAuth-style providers, add a dedicated menu entry that doesn't go through the API-key wizard)
8. If the provider implements `getUsageStatus` / `subscribeUsage`, the existing `/manage/connections/:id/usage` endpoint surfaces it automatically

### Changing what the `smoketest` probe walks through

The smoketest contract — walk setup once, observe two in-game turns — is documented in [e2e-harness.md](e2e-harness.md) ("What `smoketest` actually does") and in [CLAUDE.md](../CLAUDE.md) ("Validating changes end-to-end"). If you change what the probe does (extra setup steps, different turn count, an added assertion), update both.

The probe source itself is at `packages/test-harness/bin/smoketest.ts`. There is no registry — it's a standalone script invoked by `npm run smoketest`.

### Changing harness primitives (wait helpers, input methods, state shape, engine-log breadcrumbs)

1. Update the method on `Harness` / re-export from `packages/test-harness/src/index.ts`
2. Update the "State-driven waiting" table in [e2e-harness.md](e2e-harness.md)
3. If you added a new engine-log event category, append a row to the "Engine-log breadcrumbs" table in the same doc

### Changing what `/smoketest` does

The skill at `.claude/skills/smoketest/SKILL.md` is the single source of truth for how agents and users invoke the harness. If you change the argument convention, the "do/don't delegate to a subagent" guidance, or the set of long-lived probes, edit that file. The skill's description field is what triggers it for agents — keep it specific about the trigger phrases ("smoke test", "validate end-to-end", "did I break it", etc.) so it fires when it should.

### Adding a `codex:*` event

The openai-chatgpt provider emits its own operational events (subprocess lifecycle, login flow, rate-limit warnings) via helpers in `packages/engine/src/providers/openai-chatgpt/log.ts`. Token-counting events still go through the existing `api:call` event from agent-loop-bridge — don't duplicate. New `codex:*` events require:

1. Add a helper to `log.ts`
2. Document the event name and payload in [openai-chatgpt-provider.md](openai-chatgpt-provider.md)

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
| WebSocket API | [websocket-api.md](websocket-api.md) | WS event types, payloads, connection protocol |
| REST API (auto-generated) | `/docs` endpoint | OpenAPI spec from TypeBox route schemas |
| Conventions | [CLAUDE.md](../CLAUDE.md) | Code style, testing, imports |
| openai-chatgpt provider | [openai-chatgpt-provider.md](openai-chatgpt-provider.md) | Codex app-server integration, OAuth flow, usage tracking |
| openai.ts provider | [openai-provider.md](openai-provider.md) | Direct-API adapter for openai-apikey/openrouter/custom: Responses-vs-Completions routing, streaming reasoning workaround, encrypted-reasoning replay |
| E2E test harness | [e2e-harness.md](e2e-harness.md) | Smoketest contract, harness primitives, engine-state gotchas, engine-log breadcrumbs, how to write a probe |

## Principles

- **Docs describe what exists.** Planned features live in GitHub issues, not in documentation. If a feature is removed, remove it from docs.
- **No derived counts.** Don't maintain totals of tools, subagents, etc. The canonical list is the list — count the entries if you need a number.
- **Design docs are specs.** They describe data models, contracts, and invariants. `docs/` describes navigation and architecture. `CLAUDE.md` describes conventions. Don't duplicate across layers.
- **Same commit.** Code changes and their doc updates should be in the same commit so they can't drift.
