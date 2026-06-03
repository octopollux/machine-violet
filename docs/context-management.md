# Context Window Management Design

The DM runs on Opus, which is the most expensive model. Every token in the conversation history is paid on every turn. Context management is not just about fitting within limits — it's about cost control. The goal is to keep the conversation as small as possible while preserving the DM's ability to narrate coherently.

## Core Principle: Filesystem Is Memory, Conversation Is Ephemeral

The entity filesystem, campaign log, and scene transcripts are the DM's long-term memory. The conversation history is short-term — just the last few exchanges, enough for conversational coherence and tone. If the DM needs to remember something from earlier, it reads a file.

## Context Layout

```
┌───────────────────────────────────────────────────────┐
│ CACHED PREFIX (stable within a scene, ~10% input cost)│
│                                                       │
│ System prompt: DM identity                     ~800t  │
│ Tool definitions: all available tools         ~2000t  │
│ Rules appendix: distilled rule cards          ~1500t  │
│ PC sheets: verbatim character files            ~2000t  │
│ Session recap: "last time..."                  ~300t  │
│ Campaign summary: log with wikilinks           ~800t  │
│ Active state: location, PC summaries, alarms  ~1500t  │
│ Current scene summary: running precis          ~500t  │
│                                        Total: ~9500t  │
├───────────────────────────────────────────────────────┤
│ CONVERSATION (accumulates within scene, cached rate)   │
│                                                       │
│ All scene exchanges: player input, tool stubs,        │
│ DM responses            Cleared at scene transition   │
├───────────────────────────────────────────────────────┤
│ CURRENT INPUT (full input cost)                       │
│                                                       │
│ Player's latest message                       ~100t   │
└───────────────────────────────────────────────────────┘
```

### Cost mechanics

With automatic prompt caching, conversation tokens that were present on the previous turn are read at cache rate (~25% of full input). Only the newest exchange pays full input rate. This makes retaining the full scene conversation cheap, and makes anything that invalidates the cached prefix (system/tools/messages/model changes) disproportionately expensive — the next turn re-pays cache-write rates for the entire prefix.

Live per-turn cost surfaces in the modeline (USD via `CostTracker`); specific dollar figures aren't tracked here because model selection and pricing shift too fast for the docs to stay honest.

## Conversation Retention

Conversation accumulates within a scene and is cleared at scene transition. With automatic caching, retained exchanges are read at cache rate (~25% of full input), so the cost of keeping more history is low. The DM decides when to cut based on the narrative; the scene-pacing line in its prefix gives raw exchange + open-thread counts but no directive.

### Configuration

```jsonc
// config.json
{
  "context": {
    "retention_exchanges": 100,       // effectively unlimited within a scene
    "max_conversation_tokens": 0      // 0 = disabled (default)
  }
}
```

**`retention_exchanges`**: Maximum exchanges to keep. Set high (100) so exchanges accumulate until scene transition clears them. The DM sees the full scene conversation, which improves coherence and eliminates mid-scene cache invalidation from dropped exchanges.

**`max_conversation_tokens`**: Token ceiling for the conversation window. **Default 0 (disabled).** Mid-scene exchange pruning invalidates the prompt cache and is counterproductive — DM-driven scene transitions are the intended mechanism for managing long scenes. Can be set to a positive value as an emergency backstop, but should not be needed in normal operation.

**No tool result stubbing.** Tool results are kept in full. With caching, prior-turn tool results are read at cache rate, so the token savings from stubbing are negligible. Keeping full results lets the DM reference recent rolls, lookups, and actions without re-querying.

## Scene Summary: The Running Precis

The cached prefix includes a "current scene summary" — a running precis of the current scene so far. With the full conversation retained, the precis primarily serves as a compact summary for the cached prefix rather than as a compensating mechanism for lost exchanges.

The precis is updated when:
- An exchange is dropped due to `max_conversation_tokens` (if enabled) — a Haiku subagent appends a terse summary and extracts a **PlayerRead** (focus tags, tone, off-script detection). See [subagents-catalog.md](subagents-catalog.md) §5 for the full PlayerRead interface.
- On scene transition, the full precis is regenerated from the scene transcript on disk

**PlayerRead note:** With `max_conversation_tokens` disabled by default, the precis updater and PlayerRead extraction only fire on scene transition. If finer-grained PlayerRead data is needed, a periodic extraction trigger could be added (see issue #73).

Example precis:
```
Scene 14: Combat in the throne room. Round 1-6: [Aldric](../characters/aldric.md)
engaged [G1](../characters/g1.md) and [G2](../characters/g2.md). G1 eliminated R4.
G2 retreated to corridor R5, currently behind half cover. [Sable](../characters/sable.md)
cast Hold Person on [G3](../characters/g3.md) R3, failed (WIS save 16).
Aldric: 28/42 HP, 2/4 spell slots remaining. Sable: 19/22 HP.
G2: 3/12 HP. G3: 12/12 HP, prone. Party in center of room, G3 near east door.
```

Dense, wikilinked, mechanically precise. ~150 tokens for 6 rounds of combat. The DM can narrate from this even if the verbatim conversation for those rounds has been dropped.

## Name Inspiration Sample

A fresh multicultural name sample is injected into the DM's cached prefix at the start of every session, emitted as a `## Name Inspiration` block by the prefix builder. Its sole purpose is **entropy injection**: LLMs tend to reuse a small set of names across sessions; exposing a different random sample each session shifts the model's priors without prescribing specific choices.

**Pool** (`packages/engine/src/assets/names/names.json`): a static JSON file with two string arrays — `given` (given names) and `family` (family names) — drawn from a broad range of cultural and linguistic origins.

**Sampling** (`packages/engine/src/agents/name-inspiration.ts`): at session start, `buildNameInspiration()` selects 30 given names and 30 family names (its default counts) via a partial Fisher-Yates shuffle over an index array. Selection is without replacement within each list. The sample is clamped to the pool size if a list is shorter than the requested count.

**Prompt framing**: the rendered block opens with "AI agents like you tend to favor the same names when creating characters" and presents the sample as "For inspiration only — don't feel bound to this list". This framing keeps the DM from treating the list as authoritative.

**Caching**: `buildNameInspiration()` is called once in `session-manager.ts` and stored in `DMSessionState.nameInspiration`. The value rides the Tier 2 cached prefix for the whole session — it does not regenerate per turn. Because `Math.random` is used (not a seeded PRNG), the sample differs across sessions even for the same campaign; the `rng` parameter is overridden only in tests for determinism.

## Per-Turn Ephemeral Messages and BP4 Cache Stamping

Each turn, `game-engine.ts` builds **two** versions of the user message:

- **`apiUserMessage`** — sent to the provider; the player's tagged input prefixed with a volatile per-turn `<context>` preamble (active state, behavioral reminders, scene pacing, length steering). Marked `ephemeral: true` whenever a preamble is present (`ephemeral: preamble.length > 0`).
- **`storedUserMessage`** — persisted to conversation history; the bare tagged player input only, no preamble.

The `ephemeral` flag is an optional field on the `NormalizedMessage` interface (`packages/engine/src/providers/types.ts`). Its contract: *this message's bytes will not be present on subsequent turns*, because the stored version is the preamble-stripped one.

### Why this matters for BP4 caching

The Anthropic provider stamps the BP4 (`messages`-target) cache breakpoint on a position whose bytes are **identical across turns**. If it stamped on an ephemeral message (the current turn's preamble-bearing user message), the next turn would send the stripped variant at that position, the cached prefix would diverge there, and the entire conversation tail would need to be rewritten at full input cost.

To avoid this, `toAnthropicParams` in `packages/engine/src/providers/anthropic.ts` walks backwards from the last message, skipping any ephemeral messages, and stamps BP4 on the last non-ephemeral message:

```
let stampMsgIdx = messages.length - 1;
while (stampMsgIdx >= 0 && patchedMessages[stampMsgIdx]?.ephemeral) {
  stampMsgIdx--;
}
// stamp cache_control on messages[stampMsgIdx]
```

Within a tool-use loop, newly appended `tool_use` / `tool_result` messages are non-ephemeral and stable, so BP4 stamps on them as usual and within-round caching is preserved.

### Orphan-patch propagation

When `orphan-patch.ts` re-emits a user message — consolidating tool-result blocks into one message and re-emitting any non-result blocks as a following message — both output messages inherit the original message's `ephemeral` flag (`ephemeral: next.ephemeral`). This preserves the BP4 skip invariant through the patch: if the original message was ephemeral, the split fragments are too.

## Terseness as a Design Discipline

Every boundary where tokens cross into the DM's context must be optimized for minimum tokens.

### Tool results
Tool implementations return the minimum useful information. Examples:

| Tool | Verbose (avoid) | Terse (target) |
|---|---|---|
| `resolve_turn` | Full breakdown with explanations, 200t | `"Hit (23 vs AC 13). 9 slash. G1: 3/12 HP."` 20t |
| `map` (view) | 15x15 grid + full legend, 400t | Smallest relevant viewport + active entities only, 150t |
| `scene_transition` | Paragraph about what happened, 200t | `"Scene closed. Alarm: orc warband 2 days out."` 15t |
| `roll_dice` | Full explanation of the roll, 100t | `"2d20kh1+5: [18,7]→23"` 15t |

### Subagent returns
Every subagent prompt includes an explicit instruction: **respond in the minimum tokens necessary.** The DM doesn't need Haiku's reasoning — just the answer.

### Summaries
Haiku-generated summaries (scene summaries, campaign log entries, precis updates) are explicitly instructed to be terse: one line per significant event, wikilinks preserved, no filler.

## Delegation as Cost Control

Every question the DM asks itself that has a mechanical or lookup-based answer should be delegated to Haiku. Not because Opus can't answer it, but because answering it costs Opus reasoning tokens (output) and the lookup material costs Opus input tokens.

Examples of delegation:

| DM's question | Without delegation | With delegation |
|---|---|---|
| "Can the rogue hide?" | DM reads conditions, rules → many input tokens | Haiku returns `"Yes, dim light + half cover"` → 10 tokens in DM context |
| "What does this NPC know?" | DM reads NPC file + lore → many input tokens | Haiku returns terse summary → 50 tokens in DM context |
| "What's in this room?" | DM reads location file → many input tokens | Haiku returns key details → 30 tokens in DM context |

The DM's input context stays small. Haiku does the reading in its own cheap context.

## Lifecycle

```
Session start:
  → Build cached prefix: system prompt, tools, rules, PC sheets,
    campaign summary, session recap, active state, name-inspiration sample
  → PC sheets read verbatim from characters/<slug>.md; not refreshed
    again until next session start (stale-vs-disk after scribe edits is
    accepted — the DM sees its own scribe call in the conversation)
  → Conversation is empty (or session_resume provides a brief recap)

Each exchange:
  → Player input added to conversation
  → DM responds (tool calls + narrative)
  → If all tool calls are TUI-only (fire-and-forget):
      → Tool results recorded in conversation history
      → Acknowledgment API call skipped (saves one Opus round-trip)
  → Exchange recorded in full (tool results preserved)
  → If conversation exceeds max_conversation_tokens:
      → Oldest exchanges dropped until under cap
      → Haiku appends terse summary to scene precis
  → Exchange accumulates in conversation (no mid-scene drops normally)

Scene transition:
  → Full transcript already on disk
  → Haiku writes campaign log entry
  → Conversation cleared entirely
  → Scene precis reset
  → Cached prefix refreshed (new location, updated summaries, alarms)
  → New scene starts with empty conversation

Context refresh (mid-scene, DM-initiated):
  → Scene precis regenerated from transcript on disk
  → Active state re-read (character sheets, map viewport)
  → Cached prefix updated (causes one cache miss, then re-cached)
  → Conversation retained as-is

Session end:
  → Final scene transition
  → Haiku writes session recap
  → State checkpointed
```

## Monitoring

The app should track and optionally display:
- Current conversation size (tokens)
- Estimated cost per turn
- Session running total
- A warning if conversation is growing faster than expected (e.g., tool-heavy turns)

This helps users understand costs and helps us tune the retention window.

### Anthropic cache-miss attribution (`cache-diagnosis-2026-04-07` beta)

The Anthropic provider sends the `cache-diagnosis-2026-04-07` beta header on every call where the caller supplies a `conversationId`. That is the opt-in signal: without a `conversationId` neither the header nor the `diagnostics` request field is attached, so the feature is inert for callers that omit it. In practice `conversationId` is set on DM and subagent calls, so attribution is active on that traffic.

**Threading mechanism.** The provider maintains an in-process `previousIdByConversation: Map<string, string>` keyed by `conversationId` (the value is the most recent successful response `id` on that chain). On each call it passes `diagnostics: { previous_message_id: <last known id or null> }` alongside the model parameters. On a successful response the cursor advances to `response.id`. A thrown error leaves the prior id in place so a retry-then-success doesn't break the chain. The map is process-scoped and lost on restart; the API treats a `null` `previous_message_id` as a first turn (no comparison, but it anchors the next turn).

**Response parsing — four states.** `extractCacheDiagnostics(response)` (`packages/engine/src/providers/anthropic.ts`, exported for tests) handles the four documented states of the `diagnostics.cache_miss_reason` field:

| State | Shape | Meaning | Result |
|---|---|---|---|
| Absent | `diagnostics` field missing | Feature not enabled | `undefined` |
| Null | `diagnostics` present, `cache_miss_reason: null` | First turn, or comparison ran and found no divergence | `undefined` |
| Pending | `cache_miss_reason` is an object with no `type` | Comparison still running when the response was serialized | `undefined` |
| Populated | `cache_miss_reason: { type, cache_missed_input_tokens? }` | Divergence located | `CacheDiagnostics` |

Only the populated state produces an actionable result.

**`CacheDiagnostics` struct** (`packages/engine/src/providers/types.ts`):

```ts
interface CacheDiagnostics {
  reasonType: string;           // e.g. "system_changed", "tools_changed",
                                //      "messages_changed", "model_changed",
                                //      "previous_message_not_found", "unavailable"
  missedInputTokens?: number;   // estimated tokens after the divergence point
}
```

`reasonType` is kept as `string` (not a union) so newly added API types don't break parsing.

**Engine-log events.** When `reasonType` ends in `_changed` (the actionable subset indicating an actual prompt-prefix divergence), `extractCacheDiagnostics` emits a `cache:miss` event to `engine.jsonl` with fields `messageId`, `model`, `reasonType`, and optional `missedInputTokens`. The `previous_message_not_found` and `unavailable` types are not logged — they mean the API couldn't produce a comparison, not that the prompt structure is wrong.

Every `api:call` event in `engine.jsonl` also conditionally carries the diagnosis as `cacheMissReason` and (when known) `cacheMissedInputTokens`. These fields are omitted entirely when `cacheDiagnostics` is absent.

Cache misses are disproportionately expensive (the whole prefix re-pays cache-write rates), so attribution is the primary tool for chasing cost regressions.
