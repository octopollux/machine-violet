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
│ Session recap: "last time..."                  ~300t  │
│ Campaign summary: log with wikilinks           ~800t  │
│ Active state: location, PC summaries, alarms  ~1500t  │
│ Current scene summary: running precis          ~500t  │
│                                        Total: ~7500t  │
├───────────────────────────────────────────────────────┤
│ CONVERSATION (recent exchanges only, full input cost) │
│                                                       │
│ Last N exchanges: player input, tool stubs,           │
│ DM responses                           Target: ~3-5Kt │
├───────────────────────────────────────────────────────┤
│ CURRENT INPUT (full input cost)                       │
│                                                       │
│ Player's latest message                       ~100t   │
└───────────────────────────────────────────────────────┘
```

### Cost model (at current Opus pricing: $5/M input, $0.50/M cached, $25/M output)

```
Cached prefix:     ~8K tokens × $0.50/M  = ~$0.004/turn
Conversation:      ~4K tokens × $5/M     = ~$0.02/turn
Output:            ~300 tokens × $25/M   = ~$0.008/turn
───────────────────────────────────────────────────
Per turn:          ~$0.03
Per session (60t): ~$1.80-2.00 for Opus DM
Haiku subagents:   ~$0.30-0.70 for the session
───────────────────────────────────────────────────
Total session:     ~$2-3
```

## Conversation Retention

The conversation history keeps only the last N exchanges. An "exchange" is one player input + the DM's tool calls and response. Everything older is dropped from conversation history (but is already captured in the scene transcript on disk).

### The retention window is a tunable knob.

```jsonc
// config.json
{
  "context": {
    "retention_exchanges": 5,     // keep last N exchanges in conversation
    "max_conversation_tokens": 8000,  // hard cap regardless of exchange count
    "tool_result_stub_after": 2   // replace full tool results with stubs after N exchanges
  }
}
```

**`retention_exchanges`**: How many recent exchanges to keep in full. Start at 5, tune from there. Too low and the DM loses the thread of a conversation. Too high and costs climb. The right number probably depends on play style — combat needs fewer (each round is self-contained), deep NPC roleplay needs more (conversational callbacks matter).

**`max_conversation_tokens`**: A hard ceiling. Even if 5 exchanges happen to be very tool-heavy, the conversation won't exceed this. Oldest exchanges are dropped first.

**`tool_result_stub_after`**: Full tool results (map viewports, resolve_action breakdowns) are replaced with one-line stubs after N exchanges. A resolve_action result from 3 turns ago becomes `[resolve_action → "Hit, 9 slashing, G1: 3/12 HP"]`. The DM already narrated it; the stub is just a breadcrumb.

## Scene Summary: The Running Precis

The cached prefix includes a "current scene summary" — a running precis of the current scene so far. This compensates for the short conversation window by giving the DM a compressed record of everything that's happened in this scene, not just the last few exchanges.

This precis is updated periodically:
- Every time an exchange is dropped from the conversation window, a Haiku subagent appends a terse summary of that exchange to the precis and extracts a **PlayerRead** — structured engagement signals (engagement level, focus tags, tone, pacing, off-script detection). See [subagents-catalog.md](subagents-catalog.md) §5 for the full PlayerRead interface.
- On `context_refresh`, the full precis is regenerated from the scene transcript on disk

This is the key mechanism that lets the DM feel like it has a handle on the scene despite only seeing the last few exchanges verbatim. The precis is in the cached prefix, so it costs ~10% of the conversation rate.

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

## Terseness as a Design Discipline

Every boundary where tokens cross into the DM's context must be optimized for minimum tokens.

### Tool results
Tool implementations return the minimum useful information. Examples:

| Tool | Verbose (avoid) | Terse (target) |
|---|---|---|
| `resolve_action` | Full breakdown with explanations, 200t | `"Hit (23 vs AC 13). 9 slash. G1: 3/12 HP."` 20t |
| `view_area` | 15x15 grid + full legend, 400t | Smallest relevant viewport + active entities only, 150t |
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
  → Build cached prefix: system prompt, tools, rules, campaign summary,
    session recap, active state
  → Conversation is empty (or session_resume provides a brief recap)

Each exchange:
  → Player input added to conversation
  → DM responds (tool calls + narrative)
  → If conversation exceeds retention_exchanges:
      → Oldest exchange dropped from conversation
      → Haiku appends terse summary to scene precis
      → Tool results older than stub threshold → replaced with stubs
  → If conversation exceeds max_conversation_tokens:
      → Additional oldest exchanges dropped until under cap

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
