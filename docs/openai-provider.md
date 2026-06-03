# openai.ts Provider (openai-apikey and openrouter)

The `openai.ts` adapter (`packages/engine/src/providers/openai.ts`) handles the `openai-apikey` and `openrouter` connection types, plus any `custom` OpenAI-compatible endpoint. It wraps the official OpenAI SDK and talks directly to `api.openai.com`, `openrouter.ai`, or a local server. It is distinct from the `openai-chatgpt` provider (see [openai-chatgpt-provider.md](openai-chatgpt-provider.md)), which drives the Codex app-server subprocess over JSON-RPC for ChatGPT-account auth.

The adapter owns format translation between the engine's normalized message shape and OpenAI's wire formats: `tool_calls` carry `function.arguments` as a JSON string (vs Anthropic's parsed object), streaming events differ per API, and reasoning tokens and automatic prefix caching are handled per path.

## Responses API vs Chat Completions routing

A single set drives the routing decision:

```ts
const RESPONSES_API_PROVIDERS = new Set(["openai-apikey", "openrouter"]);
```

`useResponsesAPI(providerId)` returns true for `openai-apikey` and `openrouter`, and the provider routes those through `client.responses.*` (the OpenAI Responses API). For any other provider id — i.e. `custom` OpenAI-compatible endpoints such as Ollama, vLLM, or llama.cpp — it returns false and the provider falls back to `client.chat.completions.*` (the Chat Completions API), which custom endpoints are assumed to implement. The routing gate is consulted in `chat()`/`stream()` dispatch and again in `healthCheck()`, which probes whichever API the provider would actually use.

The same gate also decides image-generation capability: `generateImage` is only wired (and `getCapabilities().imageGeneration` only true) on the Responses API path, because the Chat Completions fallback has no Images API equivalent. See [image-generation.md](image-generation.md) for the image pipeline itself.

## Streaming reasoning: SDK accumulator bug workaround

The OpenAI SDK's `ResponseStream` accumulator has cases for `output_text` deltas, `function_call` argument deltas, and content-part additions, but **no cases** for `response.reasoning_summary_part.added` or `response.reasoning_summary_text.*` events. The bare reasoning item pushed by `response.output_item.added` ships with `summary: []` and is never populated, so `finalResponse().output[i].summary` is empty on the streaming path even when the API did stream summary parts. Walking `finalResponse()` for reasoning is therefore unreliable when streaming.

`responsesStream` works around this by listening to raw events directly:

- `response.reasoning_summary_text.done` — carries the complete text for one summary part (authoritative; the function uses `.done` rather than accumulating `.delta` events).
- `response.output_item.done` — for `reasoning` items, captures the `encrypted_content` blob (only present when the request opted in via `include`). Reasoning items only expose `encrypted_content` once fully done. Captures are keyed by item id in a `Map` (last-write-wins) so a duplicate `done` can't replay the same reasoning input twice on the next turn — the Responses API rejects duplicate item ids.

The captured summary text and encrypted reasoning items are passed explicitly into `fromResponsesResponseWithText` rather than trusting the `finalResponse()` snapshot for reasoning. (Tool calls and message text on the streaming path still come from the `finalResponse()` walk — the SDK accumulator is reliable for those.) The comment block at the top of `responsesStream` references `node_modules/openai/lib/responses/ResponseStream.mjs`.

## Encrypted reasoning and store: false

Every Responses API call sets `store: false` — no server-side thread storage. The engine always owns conversation history.

When a turn requests any reasoning effort (`params.thinking.effort`), `toResponsesParams` adds both:

- `reasoning: { effort, summary: "concise" }` — the effort string maps the engine's `low`/`medium`/`high`/`max` to OpenAI's `low`/`medium`/`high`/`xhigh`.
- `include: ["reasoning.encrypted_content"]` — opts into the opaque per-reasoning-item encrypted blob.

The blob is what makes reasoning survive across turns under `store: false`. Without it, a `store: false` session restarts cold every turn; the observed symptom is the model re-deriving its tool inventory and role ("do I have roll_dice, am I the DM?") deep into a campaign. The blobs are opaque to the engine — they are persisted as `reasoning` ContentParts on the assistant message and replayed on the next turn. The human-readable summary text surfaces separately via `thinkingText`.

On the **non-streaming** path, `fromResponsesResponseWithText` extracts both the summary text and the `encrypted_content` blob from each `reasoning` output item in the `finalResponse` walk. A reasoning item is only persisted as a `reasoning` ContentPart when its blob is present; an empty shell is dropped, since it would round-trip back as an invalid input item.

## Reasoning replay ordering

`toResponsesInput` reconstructs Responses API input items from normalized history. The Responses API contract requires reasoning items to precede the message and `function_call` items they reason about within an assistant turn. The function therefore emits all `reasoning` ContentParts first (in capture order), then walks the content again to flush text and `tool_use` items in their original interleaved order.

Because of this re-sort, the relative position of reasoning parts versus text/tool_use parts as stored in `assistantContent` does not matter — the streaming path pushes reasoning items late and the non-streaming path pushes them early, and either way the replay order is normalized here. Orphaned `tool_use` blocks are healed by `patchOrphanedToolUses` before mapping so OpenAI's strict `function_call` ↔ `function_call_output` pairing doesn't 400 on replays of corrupted history. (No block-order normalization is needed — the Responses API accepts interleaved text/function_call items.)

This same encrypted-blob round-trip is used by the `openai-chatgpt` provider via a different capture path; see [openai-chatgpt-provider.md](openai-chatgpt-provider.md) (Reasoning preservation across turns).

## Chat Completions path: no reasoning preservation

The Chat Completions fallback (custom OpenAI-compatible endpoints) supports tool calls, streaming, and reasoning-effort hints (via the flat `reasoning_effort` parameter), but **cannot** preserve reasoning across turns. The Chat Completions API has no encrypted-blob equivalent that the model accepts back on subsequent turns; vendor-specific reasoning fields (DeepSeek's `reasoning_content`, Ollama's `thinking`, etc.) are display-only with no round-trip contract. Each turn's reasoning is re-derived from history on this path. This is an upstream API limitation, not an adapter gap.
