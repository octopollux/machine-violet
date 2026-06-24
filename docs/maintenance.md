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

### Changing the DM formatting pipeline / vocabulary

1. Add/alter the tag in the `FormattingTag` union in `packages/shared/src/types/tui.ts` (the single source of truth) and handle it in both renderers — `render-nodes.tsx` (Ink) and `commands/transcript.ts` (HTML) — plus the node-walkers in `formatting.ts`
2. Map any dialect/synonym for it in `packages/client-ink/src/tui/narrative/normalize.ts`
3. Teach it in the `<formatting>` block of `packages/engine/src/prompts/dm-directives.md` and update the tag list + pipeline stages in [tui-design.md](tui-design.md)
4. Extend the invariant harness (`packages/client-ink/src/tui/narrative/harness/`): add a fixture and, if it's a new construct, a generator production. Run `npx vitest run packages/client-ink/src/tui/narrative/` and the soak (`MV_FORMAT_SOAK=1`, and `MV_LIVE_CORPUS=<dir>` against real campaigns) — zero violations is the gate

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

### Changing the tape format (Tier-2 record/replay)

The tape schema (`packages/engine/src/providers/tape.ts`) is the data contract for golden replay. If you change the shape, bucketing, matching, or determinism normalization, update [tape-format.md](tape-format.md) **and** bump `TAPE_VERSION` with a matching re-record of the corpus (`npm run golden:record`). `deserializeTape` rejects version mismatches, so a stale corpus fails loudly rather than mis-replaying.

### Changing the golden corpus / record-replay wiring

Two co-located corpora: the DM corpus (`packages/engine/src/testing/corpus.golden.test.ts`) and the setup corpus (`setup-corpus.golden.test.ts`), sharing `goldens/`. Both inject a provider directly (record via `createTapingProvider`, replay via `createReplayProvider`) — the in-process path skips the `wrapForRecording` seam. That seam (`packages/engine/src/providers/tape-mode.ts`, called at `session-manager.ts` / `setup-session.ts`) plus `GET /tape` (`packages/engine/src/server/routes/dev.ts`) + `mvplay record`/`save-tape` is the *full-stack* capture path. Adding a setup scenario = one `SetupScenario` entry + a record run (front-load the player name; `MV_SETUP_TRACE=1` prints the flow). If you change the operating model (record paths, when to re-record, hooks), update [golden-tapes.md](golden-tapes.md) and the `/record-tape` + `/replay-goldens` skills.

### Changing what the live `smoketest` probe walks through

The smoketest is the **Tier-3 live smoke** (not the regression gate — that's Tier-2 golden replay). Its contract — walk setup once, observe two in-game turns — is in [e2e-harness.md](e2e-harness.md) ("What `smoketest` actually does") and [CLAUDE.md](../CLAUDE.md) ("Validating changes end-to-end"). If you change what the probe does, update both. The source is `packages/test-harness/bin/smoketest.ts` (no registry; `npm run smoketest`).

### Changing harness primitives (wait helpers, input methods, state shape, engine-log breadcrumbs)

1. Update the method on `Harness` / re-export from `packages/test-harness/src/index.ts`
2. Update the "State-driven waiting" table in [e2e-harness.md](e2e-harness.md)
3. If you added a new engine-log event category, append a row to the "Engine-log breadcrumbs" table in the same doc

> **Engine log vs. span trace.** Flat lifecycle/latency breadcrumbs go to `engine.jsonl` via `logEvent`. *Timing spans* (the per-turn causal tree behind the campaign-explorer Timeline) are a separate stream — `trace.jsonl` via `withSpan` (`packages/engine/src/context/trace.ts`). Add a span only at a genuine nesting boundary (a new agent/tool/loop kind); don't duplicate an `engine.jsonl` breadcrumb as a span. See [state-atlas.md](state-atlas.md) §9.

### Changing what the e2e skills do

The skills are the single source of truth for how agents/users invoke each tier: `.claude/skills/replay-goldens/` (the regression gate), `.claude/skills/record-tape/` (recording), `.claude/skills/smoketest/` (live Tier-3), `.claude/skills/play/` (live-pilot + record substrate). If you change an invocation convention or the tier roles, edit the matching skill — its `description` field is what triggers it, so keep the trigger phrases accurate (e.g. "did I break it" must point at `replay-goldens`, not `smoketest`).

### Adding a `codex:*` event

The openai-chatgpt provider emits its own operational events (subprocess lifecycle, login flow, rate-limit warnings) via helpers in `packages/engine/src/providers/openai-chatgpt/log.ts`. Token-counting events still go through the existing `api:call` event from agent-loop-bridge — don't duplicate. New `codex:*` events require:

1. Add a helper to `log.ts`
2. Document the event name and payload in [openai-chatgpt-provider.md](openai-chatgpt-provider.md)

### Adding a seed-authoring design bar or changing the review loop

When a catalog pass surfaces a new "what makes a seed good/bad" bar, or you change
the review-loop process, record it in [seed-authoring.md](seed-authoring.md) (the
editorial practice doc). The `.mvworld` **schema** — forks, channels,
materialization — is separate and lives in [format-spec.md §10](format-spec.md#10-world-files-mvworld); don't duplicate it. Durable design principles should also go to memory so they survive future sessions.

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
| E2E strategy / live harness | [e2e-harness.md](e2e-harness.md) | Three-tier strategy; Tier-3 live harness — probes, mvplay, engine-state gotchas, engine-log breadcrumbs |
| Golden tapes (Tier-2) | [golden-tapes.md](golden-tapes.md) | Record/replay operating model, corpus, record paths, when to re-record |
| Tape format | [tape-format.md](tape-format.md) | On-disk tape schema, bucketing, ordinal matching, determinism normalization |
| Seed authoring | [seed-authoring.md](seed-authoring.md) | Editorial playbook for bundled `.mvworld` seeds: design bars, review checklist, review-pass loop |

## Principles

- **Docs describe what exists.** Planned features live in GitHub issues, not in documentation. If a feature is removed, remove it from docs.
- **No derived counts.** Don't maintain totals of tools, subagents, etc. The canonical list is the list — count the entries if you need a number.
- **Design docs are specs.** They describe data models, contracts, and invariants. `docs/` describes navigation and architecture. `CLAUDE.md` describes conventions. Don't duplicate across layers.
- **Same commit.** Code changes and their doc updates should be in the same commit so they can't drift.
