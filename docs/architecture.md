# Architecture

How the system works, mapped to actual code paths.

## Core Loop

The game uses a two-tier architecture: a Fastify engine server (`packages/engine`) and an Ink TUI client (`packages/client-ink`), communicating via REST + WebSocket on localhost.

```
Player input (client)
  → POST /session/turn/contribute (REST)
  → GameEngine (packages/engine/src/agents/game-engine.ts)
    → builds messages: system prompt + conversation history + new input
    → Claude API call (Opus tier)
    → response: text blocks + tool_use blocks
      → ToolRegistry.dispatch() for each tool
      → StatePersister writes changed state slices
      → Bridge translates EngineCallbacks → WebSocket events
      → if ALL tools are TUI: bail out (skip ack round-trip)
      → else: send tool_results back, loop for next response
    → ConversationManager tracks the exchange
    → if exchange dropped from window: Haiku precis updater runs
  → narrative:chunk / narrative:complete events → client renders to terminal
```

**Entry points:**
- **Launcher:** `scripts/launcher.ts` → starts server + client in one process
- **Engine:** `packages/engine/src/index.ts` → Fastify server
- **Client:** `packages/client-ink/src/index.tsx` → Ink TUI
- **Dev:** `scripts/dev-two-tier.js` → two-process dev mode

## Execution Tiers

Every operation has an explicit cost tier. This is the core economic constraint.

| Tier | Model | Cost | Used for | Code path |
|---|---|---|---|---|
| T1 (Code) | None | Zero tokens | Dice, maps, clocks, cards, combat, persistence | `packages/engine/src/tools/` — pure functions |
| T2 (Subagent) | Haiku or Sonnet | Cheap | Summarization, precis, changelogs, resolution, choices, entity writes | `packages/engine/src/agents/subagents/` — `spawnSubagent()` / `oneShot()` |
| T3 (DM) | Fable or Opus | Expensive | Narration, scene direction, NPC dialogue | `packages/engine/src/agents/agent-loop.ts` — main conversation |

Model selection: `packages/engine/src/config/models.ts` — `getModel("large" | "medium" | "small")` returns baked-in defaults. Per-tier provider/model assignment lives in `connections.json` (managed via the Connections UI); the same store carries an optional `imageAssignment`. An explicit image model is always paired to the exact Large-tier connection and is cleared when Large moves to another connection. A null assignment preserves the renderer's provider-managed default. Text models and selectable image models live in separate `models` / `imageModels` sections of `known-models.json`; `dev-config.jsonc` exposes optional dev-only `effort` and `pricing` overrides.

**Provider routing:** every model call is paired `{provider, model}` — a `TierProvider` (`packages/engine/src/providers/types.ts`). At session start, `buildTierProviders` (`src/config/tier-resolver.ts`) reads the connection store and produces `Record<ModelTier, TierProvider>`, which threads through `GameEngine`, `SceneManager`, and `ResolveSession` to every subagent dispatch site. The resolver also returns the optional Large-paired `imageModel`; setup portraits, DM scene images, and portrait revisions pass it through `GenerateImageRequest.imageModel`. This guarantees that a heterogeneous setup (e.g. Large=OpenAI, Medium=Anthropic) routes each tier's call through its own connection — sending an Anthropic model ID through an OpenAI client would crash. Subagents accept `model` as a required parameter; there is no silent fallback to `getModel(tier)`.

The `gemini` adapter uses Google's Interactions API in stateless mode. Gemini
`thought` steps and function-call signatures are preserved in normalized
history and replayed unchanged, while SSE step events normalize to the same
streaming/tool/usage contract used by the other providers. See
[gemini-provider.md](gemini-provider.md).

## Anthropic Provider: Thinking and Reasoning Preservation

The Anthropic adapter (`packages/engine/src/providers/anthropic.ts`) implements extended thinking for capable models via `ThinkingConfigParam`.

**Thinking config** (`toAnthropicParams`): thinking is enabled only for models whose `capabilities.thinking` flag is true in `known-models.json` (looked up via `getKnownModel`). When `ChatParams.thinking.effort` is set and the model supports thinking, the adapter sends `thinking: { type: 'adaptive' }` plus `output_config: { effort }`; otherwise it sends `{ type: 'disabled' }`. Models marked `alwaysAdaptiveThinking` are the exception: their API rejects disabled thinking, so an unset effort omits the thinking field and inherits mandatory adaptive thinking. When thinking is active — explicitly or because the model requires it — `max_tokens` is boosted to `Math.max(params.maxTokens, model maxOutput)` (falling back to 16384 if the model has no `maxOutput`) so thinking tokens don't starve the response.

The shipped Anthropic defaults are Claude Opus 5 (large), Claude Sonnet 5 (medium), and Claude Haiku 4.5 (small). Claude Fable 5, Opus 4.8, and retained 4.x models remain selectable. Opus 5 supports the full effort ladder through `max`; configured effort uses adaptive thinking, while Machine Violet's null effort explicitly disables thinking without sending an incompatible `xhigh` or `max` output effort. Fable 5 is marked always-adaptive.

This behavior follows Anthropic's [Opus 5 migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-opus-5) and [launch implementation notes](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5). The adapter uses the generally available model, thinking, effort, caching, and streaming contracts. It does not opt every game into the beta `fallbacks: "default"` or mid-conversation-tool-change headers; Machine Violet's tool catalog is stable within an agent session, and automatic paid fallback is a separate product policy rather than a model migration requirement.

**Cross-turn reasoning state** (`fromAnthropicResponse` + `toAnthropicMessage`): The API returns `thinking` and `redacted_thinking` content blocks in its response. Both are captured verbatim into `assistantContent`:

- `thinking` blocks: persisted with their `thinking` text and opaque `signature` field.
- `redacted_thinking` blocks: persisted with their opaque `data` payload (no visible text).

On subsequent turns, `toAnthropicMessage` emits both block types back to the API as `ThinkingBlockParam` and `RedactedThinkingBlockParam`, signature and data fields unchanged. The API auto-filters which blocks it needs and bills accordingly, so the adapter passes back everything captured rather than pruning manually. This round-trip is what lets the model continue its reasoning chain across turn boundaries rather than re-deriving context from scratch (issue #533). OpenAI `reasoning` blocks that may exist in shared history are skipped here — the Anthropic API rejects them.

This cross-provider reasoning-preservation contract is pinned by `packages/engine/src/providers/preserves-thinking.contract.test.ts`, which tests the capture + replay path for the `anthropic`, `openai-apikey` (Responses API), and `openai-chatgpt` providers; `openrouter` and `xai` share the tested Responses path, while `custom` is explicitly unsupported with documented rationale.

## State Architecture

**GameState** (`src/agents/game-state.ts`) is the single mutable source of truth. Passed to every tool handler. Contains:

- `maps` — spatial data (grids, entities, terrain, regions)
- `clocks` — calendar time + combat rounds + alarms
- `combat` — initiative order, turn tracking
- `decks` — card decks (draw piles, discard, hands)
- `config` — campaign config (read-only during play)
- `campaignRoot` — filesystem path
- `activePlayerIndex` — current player

**Shadow state** (not in GameState, managed separately):

- **SceneState** (`src/agents/scene-manager.ts`) — transcript, precis, open threads, NPC intents, player reads
- **ConversationManager** (`src/context/conversation.ts`) — exchange history with retention enforcement
- **DMSessionState** (`src/agents/dm-prompt.ts`) — transient prefix data, rebuilt from files each session

**Persistence:** All state serializes to JSON under `<campaignRoot>/state/`. `StatePersister` (`src/context/state-persistence.ts`) writes specific slices after tool dispatch, keyed by `TOOL_STATE_MAP` in `tool-registry.ts`.

Full schema and invariants: [state-atlas.md](state-atlas.md)

## Context Window Management

The DM's context is structured in layers with cache breakpoints:

```
[BP1] System prompt + rules appendix        ← cached 1h, rebuilt on scene change
[BP2] Campaign summary + session recap       ← cached 1h, rebuilt on scene change
      + scene precis + DM notes
[BP3] Tool definitions                       ← cached per request
[BP4] Conversation exchanges                 ← stamped on the last *stable* message;
                                               ephemeral per-turn preambles are
                                               skipped so cross-turn cache hits
                                               through the end of the prior turn
```

Conversation accumulates within a scene and is cleared at scene transition. With automatic caching, prior exchanges are read at cache rate. The DM chooses when to cut a scene based on the narrative; `max_conversation_tokens` defaults to 0 (disabled) since mid-scene pruning invalidates the prompt cache.

**Code:** `src/context/prefix-builder.ts` (prefix assembly), `src/context/conversation.ts` (retention), `src/agents/scene-manager.ts` (precis updates)

Full details: [context-management.md](context-management.md)

## Scene Transitions

Scene transitions are idempotent 9-step cascades. Each step is tracked in `pending-operation.json` for crash recovery.

```
1. finalize_transcript      → write transcript.md
2. subagent_updates         → Haiku: campaign log + changelogs (parallelized)
3. advance_calendar         → fire alarms
4. check_alarms             → read-only status
5. validate                 → campaign state checks
6. reset_precis             → clear scene-scoped state
7. prune_context            → empty conversation window
8. checkpoint               → git commit
9. done                     → clear pending-operation.json
```

**Code:** `src/agents/scene-manager.ts` — `sceneTransition()`, `resumePendingTransition()`

## Entity Filesystem

The campaign directory is the database. All game content is markdown with `**Key:** Value` front matter and `[[wikilinks]]`. The DM navigates knowledge by following links, not by re-reading context.

```
<campaignRoot>/
├── config.json              Campaign config (read-only during play)
├── state/                   Runtime state JSON
├── campaign/
│   ├── log.md               Append-only campaign log
│   ├── session-recaps/      Haiku-generated recaps
│   └── scenes/NNN-slug/     Scene transcripts + DM notes
├── characters/              PCs, NPCs, creatures
├── locations/               Places + map JSON
├── factions/                Organizations
├── lore/                    World knowledge
└── rules/                   Game system mechanics
```

Entity I/O is abstracted through **FileIO** and **GitIO** interfaces. Production uses real `fs`; tests inject in-memory mocks.

**Code:** `src/tools/filesystem/` (parsing, validation, scaffolding), `src/agents/subagents/scribe.ts` (entity writes)

Full details: [entity-filesystem.md](entity-filesystem.md)

## Subagent Pattern

Delegation is mandatory — the DM never does mechanical work. `spawnSubagent()` creates an isolated Claude conversation with its own context window. The DM's context is never polluted.

```typescript
// One-shot pattern (most subagents)
const result = await oneShot(client, {
  model: getModel("small"),  // Haiku
  system: systemPrompt,
  prompt: inputText,
});

// Multi-turn pattern (scribe, OOC, dev mode)
const result = await spawnSubagent(client, {
  model: getModel("small"),
  system: systemPrompt,
  messages: [...],
  tools: [...],
  maxToolRounds: 8,
});
```

**Code:** `src/agents/subagent.ts` (infrastructure), `src/agents/subagents/` (all subagent implementations)

Full catalog: [subagents-catalog.md](subagents-catalog.md)

## Tool System

Tools are registered in `src/agents/tool-registry.ts`. New and migrated tools
define one TypeBox contract that supplies the provider-facing JSON Schema, the
Ajv runtime validator, and the handler's inferred input type. Existing raw JSON
Schema definitions are also executed by Ajv while migration proceeds.

Both surfaced and provider-owned in-band calls pass through
`src/agents/tool-contract.ts` in this order: contract-local repair → structural
validation → semantic refinement → handler. A rejection returns an actionable
error tool result and cannot reach persistence or success callbacks. Setup
tools have a separate dispatch loop, so `subagents/setup-conversation.ts`
applies the same validator at that boundary. Provider `strict` flags are an
optimization, not an engine invariant.

Tool handlers receive `(state: GameState, input: T)` and return `ToolResult`:
- `ok(data)` — success with content string
- `err(message)` — error with `is_error: true`
- UI/engine commands — returned as structured objects, handled by the agent loop

**TUI tools** (`TUI_TOOLS` set in `agent-loop.ts`) are fire-and-forget: their results drive engine/UI behavior but don't inform the DM's narration. Their `_tui` payloads are dispatched to the client as soon as the tool fires (non-deferred types broadcast immediately; deferred types queued for post-loop processing), so visual updates appear mid-narration instead of at turn-end. Tool_use/tool_result pairs stay in conversation history and the agent loop continues normally — an earlier bail-out optimization on TUI-only rounds was removed (#266) because it prevented the DM from completing multi-step turns.

Tools are organized by domain in `src/tools/`: dice, cards, clocks, combat, maps, filesystem, git, validation.

Full catalog: [tools-catalog.md](tools-catalog.md). Contract authoring,
criticality, repair policy, logs, and required tests:
[tool-input-contracts.md](tool-input-contracts.md).

## TUI Rendering

The terminal UI is built with Ink (React for CLI). The main layout (`packages/client-ink/src/tui/layout.tsx`) composes:

- **Modeline** — status bar (mode, turn, resources, cost)
- **NarrativeArea** — scrollable DM text with formatting
- **InputLine** — player text input

DM text goes through a formatting pipeline (`packages/client-ink/src/tui/formatting.ts`):
```
raw string → heal tags → parse to FormattingNode[] AST → wrap lines → pad alignment → quote highlight
```

Tags supported: `<b>`, `<i>`, `<u>`, `<center>`, `<right>`, `<color=#hex>`. All tags persist across source lines; only real paragraph boundaries (blank DM lines) reset the tag stack. Quote state also resets at paragraph boundaries.

**Theme system:** `.theme` asset files in `packages/client-ink/src/tui/themes/assets/` define color palettes using OKLCH color space. Variants: exploration, combat, ooc, levelup, dev.

**Code:** `packages/client-ink/src/tui/` (components, formatting, themes, modals, hooks)

Full details: [tui-design.md](tui-design.md)

## Agent Sidecar (Dev Only)

A dev-only HTTP server that embeds in the TUI client for AI agent integration testing. Activated by `--agent-port <port>` or `MV_AGENT_PORT` env var. Excluded from release builds.

| Endpoint | Method | Description |
|---|---|---|
| `/screen` | GET | Rendered terminal screen as plain text. `?ansi=true` for ANSI escape codes. |
| `/state` | GET | Client state as JSON (campaign, players, theme, mode, etc.). |
| `/input` | POST | Inject raw keystroke bytes. |
| `/input/key` | POST | Inject named key (JSON `{"key": "enter"}`). Maps to escape sequences via KEY_MAP (arrows, function keys, ctrl modifiers, etc.). |

Uses `@xterm/headless` as a virtual VT100 terminal for screen capture. When no TTY is available (e.g. agent-spawned background process), a mock stdin is created automatically so Ink runs without a real terminal (default virtual size: 120x40).

**Code:** `packages/client-ink/src/agent-sidecar.ts`
