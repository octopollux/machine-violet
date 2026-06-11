# Tape Format

The on-disk schema for session tapes (Tier-2 record/replay). The operating model
— how to record, replay, and re-record — is in [golden-tapes.md](golden-tapes.md);
this doc is the data contract. Source of truth:
[`packages/engine/src/providers/tape.ts`](../packages/engine/src/providers/tape.ts).

The tape type lives in `engine` (not `test-harness`) because it serializes
engine-owned types (`ChatResult` et al.); the dependency runs test-harness →
engine.

## Shape

```jsonc
{
  "version": 1,                       // TAPE_VERSION; deserialize rejects mismatches
  "scenario": "dm-skill-check",
  "capabilities": {                   // per-model snapshot, replayed verbatim
    "claude-haiku-4-5-20251001": { /* ProviderCapabilities */ }
  },
  "entries": [ /* TapeChatEntry | TapeImageEntry, in record order */ ]
}
```

A committed golden file wraps the tape with its replay assertion. The DM corpus
asserts the narrative:

```jsonc
{ "scenario": "...", "tape": { /* Tape */ }, "expectedNarrative": ["...", "..."] }
```

The setup corpus adds the finalized blueprint, since a setup scenario's payoff is
the campaign it produces, not just the prose:

```jsonc
{ "scenario": "...", "tape": { /* Tape */ },
  "expectedNarrative": ["...", "..."],   // per-turn setup-agent narrative
  "expectedSetup": { /* SetupResult */ } // finalize_setup output, replayed verbatim
}
```

`expectedNarrative` is the non-player narrative the scenario produced at record
time — the deterministic replay target. `expectedSetup` (setup goldens only) is
the `SetupResult` the agent finalized; replay re-derives it and the handoff
scaffolds a campaign from it.

**Full-stack goldens** (driven through the running server / a packaged binary by
[`replay-runner.ts`](../packages/test-harness/src/replay-runner.ts), not the
in-process corpus) add an `inputs` array so the replay is **self-driving** —
re-issuing the same player ops re-drives menu → setup → handoff → DM turns:

```jsonc
{ "scenario": "fullstack-quickstart", "tape": { /* Tape */ },
  "expectedNarrative": ["...", "..."],   // DM (kind "dm") lines only — the assertion target
  "inputs": [                            // ordered key/say/pick ops captured at record time
    { "kind": "key", "name": "return" },
    { "kind": "pick", "index": 0, "label": "..." },
    { "kind": "say", "text": "..." }
  ] }
```

The `inputs` field lives on the **envelope**, not the `Tape` — so it's additive
and needs no `TAPE_VERSION` bump. The `FullStackGolden` type is owned by
test-harness ([`golden.ts`](../packages/test-harness/src/golden.ts)); the engine
runtime only ever reads the bare `Tape`. Here `expectedNarrative` is **`dm` lines
only** (the verbatim DM narration), excluding `dev` breadcrumbs (environment-
specific paths, dev-only) and `player` echoes. The replay assertion is
whitespace-normalized — it compares content, not line segmentation, since
segmentation around mid-stream tool-call flushes is a streaming artifact.

## Bucketing + matching

Every chat call is filed into a **bucket** and matched **ordinally** within it:

- **Bucket** = `ChatParams.conversationId` (the agent name — `"dm"`, `"scribe"`,
  …) or `"default"` when absent. `generateImage` calls use the `"__image__"`
  bucket. Setup-agent calls carry no `conversationId`, so an entire setup
  conversation lands in `"default"` and matches ordinally — which is exactly what
  the setup corpus relies on (its calls are a single in-order sequence).
- **Ordinal** = position within the bucket. The Nth chat call in bucket B during
  replay returns the Nth recorded entry for B.

Matching is deliberately **loose**: we do NOT hash the full request and demand an
exact match. Prompts churn constantly; a benign wording tweak should yield a
readable diff + one re-record, not a cache-miss storm. Because matching is
ordinal (not content-based), engine-side RNG and tool *results* don't break
replay — the recorded LLM responses are served in order regardless, so the
sequence of LLM calls (and thus the narrative) stays fixed.

If replay asks for an entry a bucket doesn't have, the replay provider throws a
**"Tape miss"** — the run's *shape* changed (a different number/sequence of LLM
calls). Re-record, or fix the regression.

## Entries

**`TapeChatEntry`** (`kind: "chat"`):

| Field | Meaning |
|---|---|
| `bucket`, `ordinal` | the match key (above) |
| `request` | a `RequestFingerprint` — for diff legibility + soft validation, **never** the match key |
| `result` | the recorded `ChatResult`, replayed verbatim |
| `streamDeltas?` | deltas as recorded from `stream`; absent for non-streaming `chat` |

**`RequestFingerprint`** — a compact, human-readable snapshot so a tape diff is
legible: `model`, `messageCount`, `systemHash` (sha256 prefix of the system
prompt — catches system drift), `tools` (sorted names), `lastMessagePreview`
(truncated). It exists for humans and soft validation, not for keying.

**`TapeImageEntry`** (`kind: "image"`, bucket `"__image__"`): the
`GenerateImageRequest` and recorded `GenerateImageResult`. Base64 is currently
inline — fine for text-only tapes; moving image bytes to a content-addressed
sidecar so image-bearing goldens stay diffable is a tracked TODO.

## Determinism normalization

The replay must reproduce the recorded run bit-for-bit where it matters:

- **`tool_use` IDs are replayed verbatim** so the bridge re-pairs
  `tool_use`↔`tool_result` and `normalizeTurn` stays stable.
- **Internal-dispatch (codex) tool calls are re-issued on replay.** codex
  dispatches tool calls in-band via `params.dispatchTool` and leaves
  `ChatResult.toolCalls` empty — the calls survive only as `tool_use` blocks in
  `assistantContent`. `createReplayProvider` walks `assistantContent` and
  re-issues each through `dispatchTool`, or `present_choices` / `finalize_setup`
  never fire on replay. Anthropic-shape tapes surface `toolCalls` (dispatched by
  the outer loop) and are detected + left untouched, so they never double-dispatch.
- **Thinking `signature` / `redacted_thinking` / reasoning blobs** are opaque and
  replayed verbatim.
- **Image base64** is out-of-line-able (see above).
- **Usage counts** are recorded but excluded from matching; **timestamps /
  `durationMs`** are ignored.

## Versioning

`deserializeTape` throws on a `version` mismatch with a "re-record the golden"
message rather than silently mis-replaying. Bump `TAPE_VERSION` only with a
matching re-record of the corpus.

## Recording against codex vs. the API-key provider

**In-process Tier-2 corpus** (`corpus.golden.test.ts`): record against
`anthropic` / `openai-apikey`. That corpus drives the engine directly and mocks
subagents to keep each turn a single deterministic bucket; the API-key shape
(tool calls surfaced via `ChatResult.toolCalls`) is what it expects.

**Full-stack goldens** (`mvplay record` → the replay runner): codex
(`openai-chatgpt`) **is** supported — these are recorded on whatever connection
is configured, and the in-band tool calls replay via the `assistantContent`
re-dispatch described under "Determinism normalization". The earlier blanket
"never record codex" no longer holds for full-stack tapes; it survives only as
in-process-corpus guidance.
