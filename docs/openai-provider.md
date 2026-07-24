# openai.ts Provider (OpenAI, OpenRouter, xAI, and custom)

The `openai.ts` adapter (`packages/engine/src/providers/openai.ts`) handles the `openai-apikey`, `openrouter`, and `xai` connection types, plus any `custom` OpenAI-compatible endpoint. It wraps the official OpenAI SDK and talks directly to `api.openai.com`, `openrouter.ai`, `api.x.ai`, or a local server. It is distinct from the `openai-chatgpt` provider (see [openai-chatgpt-provider.md](openai-chatgpt-provider.md)), which drives the Codex app-server subprocess over JSON-RPC for ChatGPT-account auth.

The adapter owns format translation between the engine's normalized message shape and OpenAI's wire formats: `tool_calls` carry `function.arguments` as a JSON string (vs Anthropic's parsed object), streaming events differ per API, and reasoning tokens and automatic prefix caching are handled per path.

## Shipped OpenAI models

`packages/engine/src/config/known-models.json` is the source of truth for the
selectable OpenAI catalog. Both API-key and ChatGPT connections default to the
current GPT-5.6 family: Sol for the large tier, Terra for medium, and Luna for
small. GPT-5.5, GPT-5.5 Pro, the GPT-5.4 family (including mini and nano), and
the retained GPT-5/4o models remain selectable with their published context,
output, pricing, and capability metadata.

GPT-5.5 Pro does not expose SSE streaming. When selected, `stream()` falls
back to one non-streaming Responses request and emits the completed text as a
single delta, so the engine-facing provider contract still works.

The GPT-5.6 family supports a distinct `max` reasoning level. The normalized
Machine Violet `max` effort maps to API `max` for `gpt-5.6*`; older models and
compatible endpoints receive `xhigh`, preserving their supported ceiling.

## OpenRouter environment connection

At startup, `OPENROUTER_API_KEY` creates an `env-openrouter` connection with
the shipped model list and tier defaults. Like the Anthropic and OpenAI
environment connections, it is rebuilt from the process environment on every
load, cannot be deleted in the UI, and is filtered out of `connections.json` so
the key is never persisted there.

## OpenRouter model support

The shipped OpenRouter model is `moonshotai/kimi-k3`, selected for every tier.
As of the 2026-07-24 validation:

- Moonshot released Kimi K3 on 2026-07-16 as its flagship generalist for
  long-horizon coding, knowledge work, reasoning, and agent orchestration.
- OpenRouter serves the exact slug with a 1,048,576-token context at $3 / $15
  per million input/output tokens.
- A live adapter probe completed a function-tool call and result round trip, a
  streamed response, and a 305,114-input-token request.
- Kimi K3 accepts text and image input but emits text only. It does **not**
  provide image generation, so Machine Violet does not register
  `generate_image` for an OpenRouter-backed Kimi K3 session.

The last-two-week comparison also included three newer OpenRouter arrivals. All
three passed live tool-call and streaming probes, but they are poorer defaults
for a general-purpose tabletop DM:

- `poolside/laguna-s-2.1` (OpenRouter 2026-07-21) is the newest and cheapest,
  but Poolside positions it specifically as a coding-agent model.
- `meituan/longcat-2.0` (OpenRouter 2026-07-20) targets coding, repository
  changes, and long-horizon problem solving rather than creative general use.
- `thinkingmachines/inkling` (OpenRouter 2026-07-17) is a strong multimodal
  generalist, but its published capability results trail Kimi's current
  flagship on key reasoning and agentic measures.

Kimi K3 therefore wins on task fit and frontier capability rather than merely
the latest catalog timestamp. Sources:
[Moonshot Kimi K3 release](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html#kimi-k3-july-16-2026),
[Moonshot product overview](https://www.moonshot.ai/),
[Poolside Laguna S 2.1 model card](https://huggingface.co/poolside/Laguna-S-2.1),
[Meituan LongCat 2.0 model card](https://huggingface.co/meituan-longcat/LongCat-2.0),
[Thinking Machines Inkling release](https://thinkingmachines.ai/news/introducing-inkling/),
and [OpenRouter live model metadata](https://openrouter.ai/api/v1/models/moonshotai/kimi-k3/endpoints).

## Responses API vs Chat Completions routing

A single set drives the routing decision:

```ts
const RESPONSES_API_PROVIDERS = new Set(["openai-apikey", "openrouter", "xai"]);
```

`useResponsesAPI(providerId)` returns true for `openai-apikey`, `openrouter`, and `xai`, and the provider routes those through `client.responses.*` (the OpenAI Responses API). xAI officially documents both Responses and Chat Completions and publishes JavaScript examples with the OpenAI SDK pointed at `https://api.x.ai/v1`; Responses is the richer match for MV's reasoning replay. For any other provider id — i.e. `custom` OpenAI-compatible endpoints such as Ollama, vLLM, or llama.cpp — the gate returns false and the provider falls back to `client.chat.completions.*`. The routing gate is consulted in `chat()`/`stream()` dispatch and again in `healthCheck()`.

Responses routing and image routing are deliberately separate. `generateImage`
is wired only for `openai-apikey` and `xai`; the OpenAI implementation targets
the Images API and defaults to `gpt-image-2`, while xAI targets Grok Imagine.
Both honor a provider-native explicit image assignment. OpenRouter uses the Responses API for chat but does
not inherit OpenAI image support; its shipped Kimi K3 model has text-only
output. Custom Chat Completions endpoints likewise have no guaranteed Images
API. See [image-generation.md](image-generation.md) for the image pipeline.

## Streaming reasoning: SDK accumulator bug workaround

The OpenAI SDK's `ResponseStream` accumulator has cases for `output_text` deltas, `function_call` argument deltas, and content-part additions, but **no cases** for `response.reasoning_summary_part.added` or `response.reasoning_summary_text.*` events. The bare reasoning item pushed by `response.output_item.added` ships with `summary: []` and is never populated, so `finalResponse().output[i].summary` is empty on the streaming path even when the API did stream summary parts. Walking `finalResponse()` for reasoning is therefore unreliable when streaming.

`responsesStream` works around this by listening to raw events directly:

- `response.reasoning_summary_text.done` — carries the complete text for one summary part (authoritative; the function uses `.done` rather than accumulating `.delta` events).
- `response.output_item.done` — for `reasoning` items, captures the `encrypted_content` blob (only present when the request opted in via `include`). Reasoning items only expose `encrypted_content` once fully done. Captures are keyed by item id in a `Map` (last-write-wins) so a duplicate `done` can't replay the same reasoning input twice on the next turn — the Responses API rejects duplicate item ids.

The captured summary text and encrypted reasoning items are passed explicitly into `fromResponsesResponseWithText` rather than trusting the `finalResponse()` snapshot for reasoning. (Tool calls and message text on the streaming path still come from the `finalResponse()` walk — the SDK accumulator is reliable for those.) The comment block at the top of `responsesStream` references `node_modules/openai/lib/responses/ResponseStream.mjs`.

## Encrypted reasoning and store: false

Every Responses API call sets `store: false` — no server-side thread storage. The engine always owns conversation history.

When a turn requests any reasoning effort (`params.thinking.effort`), `toResponsesParams` adds both:

- `reasoning: { effort, summary: "concise" }` — the effort string maps the engine's `low`/`medium`/`high`/`max` to OpenAI's `low`/`medium`/`high`/`xhigh`. Grok 4.5 documents only `low`/`medium`/`high`, so the xAI path clamps MV's provider-neutral `max` to `high`.
- `include: ["reasoning.encrypted_content"]` — opts into the opaque per-reasoning-item encrypted blob.

The blob is what makes reasoning survive across turns under `store: false`. Without it, a `store: false` session restarts cold every turn; the observed symptom is the model re-deriving its tool inventory and role ("do I have roll_dice, am I the DM?") deep into a campaign. The blobs are opaque to the engine — they are persisted as `reasoning` ContentParts on the assistant message and replayed on the next turn. The human-readable summary text surfaces separately via `thinkingText`.

On the **non-streaming** path, `fromResponsesResponseWithText` extracts both the summary text and the `encrypted_content` blob from each `reasoning` output item in the `finalResponse` walk. A reasoning item is only persisted as a `reasoning` ContentPart when its blob is present; an empty shell is dropped, since it would round-trip back as an invalid input item.

## Reasoning replay ordering

`toResponsesInput` reconstructs Responses API input items from normalized history. The Responses API contract requires reasoning items to precede the message and `function_call` items they reason about within an assistant turn. The function therefore emits all `reasoning` ContentParts first (in capture order), then walks the content again to flush text and `tool_use` items in their original interleaved order.

Because of this re-sort, the relative position of reasoning parts versus text/tool_use parts as stored in `assistantContent` does not matter — the streaming path pushes reasoning items late and the non-streaming path pushes them early, and either way the replay order is normalized here. Orphaned `tool_use` blocks are healed by `patchOrphanedToolUses` before mapping so OpenAI's strict `function_call` ↔ `function_call_output` pairing doesn't 400 on replays of corrupted history. (No block-order normalization is needed — the Responses API accepts interleaved text/function_call items.)

This same encrypted-blob round-trip is used by the `openai-chatgpt` provider via a different capture path; see [openai-chatgpt-provider.md](openai-chatgpt-provider.md) (Reasoning preservation across turns).

## Chat Completions path: no reasoning preservation

The Chat Completions fallback (custom OpenAI-compatible endpoints) supports tool calls, streaming, and reasoning-effort hints (via the flat `reasoning_effort` parameter), but **cannot** preserve reasoning across turns. The Chat Completions API has no encrypted-blob equivalent that the model accepts back on subsequent turns; vendor-specific reasoning fields (DeepSeek's `reasoning_content`, Ollama's `thinking`, etc.) are display-only with no round-trip contract. Each turn's reasoning is re-derived from history on this path. This is an upstream API limitation, not an adapter gap.

## xAI compatibility and Grok Imagine

xAI connections use `XAI_API_KEY` (ambient env connections are auto-created) or a key pasted through Settings → API Keys. The factory supplies `https://api.x.ai/v1`; users never enter a base URL. The shipped live catalog is `grok-4.5`, `grok-4.3`, `grok-build-0.1`, and the three Grok 4.20 variants. Defaults are 4.5 / 4.3 / 4.20 non-reasoning for large / medium / small. A `conversationId` becomes xAI's `prompt_cache_key`, which xAI recommends for conversation affinity and reliable cache hits.

Grok Imagine is deliberately provider-paired: an xAI-backed large tier renders through xAI, never OpenAI. `XAI_IMAGE_MODELS` centralizes the current slugs (`grok-imagine-image`, `grok-imagine-image-quality`). `GenerateImageRequest.imageModel` carries the optional explicit assignment from the connection store; when absent, draft/standard choose the standard model at 1K, quality chooses the quality model at 1K, and showcase chooses quality at 2K. An explicit assignment pins that model while effort still controls resolution. Aspect maps to `1:1`, `2:3`, or `3:2`.

Text-to-image and image editing use JSON with `response_format: "b64_json"`. This distinction is load-bearing: xAI [explicitly says the OpenAI SDK's multipart `images.edit()` is unsupported](https://docs.x.ai/developers/model-capabilities/images/editing), so reference portraits are sent to `/images/edits` as base64 data URIs via the SDK's authenticated low-level `post`. A single-reference edit follows the source image's aspect ratio; multi-image edits honor `aspect_ratio`. Both use the shared identity/reference directive.

Grok's reasoning items remain separate from ordinary `output_text`, but the model can still emit operational self-talk as ordinary text immediately before a function call. The provider loop therefore buffers each xAI round until its final shape is known: text attached to a tool-call round is omitted from the player-visible stream and stored history, while the final text-only narration is released canonically. This prevents planning phrases such as “Opening on…” from leaking into gameplay transcripts and avoids concatenating pre-tool fragments directly onto the post-tool narration. A nominally successful xAI response that contains reasoning but no tool call or final text is retried twice before surfacing an error, rather than being accepted as an empty gameplay turn.

Primary references: [Grok 4.5](https://docs.x.ai/developers/grok-4-5), [models](https://docs.x.ai/developers/models), [streaming](https://docs.x.ai/developers/model-capabilities/text/streaming), [function calling](https://docs.x.ai/developers/tools/function-calling), and [image generation](https://docs.x.ai/developers/model-capabilities/images/generation). Live validation on 2026-07-24 proved health, a structured function call, base64 image generation, and JSON reference editing against the real API.

## OpenAI image generation: text-to-image, image-to-image, and retry

`generateImage` on `openai-apikey` defaults to `gpt-image-2` and honors `GenerateImageRequest.imageModel` when an explicit Large-paired selection is configured. With no reference images it calls `client.images.generate` (text-to-image). When the caller supplies `referenceImages` — the DM naming `reference_characters`, or `update_portrait` conditioning on the character's current portrait — the adapter switches to `client.images.edit`: each portrait's base64 is turned into an `Uploadable` via `toFile` and passed as the `image` array, conditioning the render on them (image-to-image). The shared reference directive (`buildReferenceDirective`, `packages/engine/src/providers/image-reference-directive.ts`) is appended to the prompt so the edit takes identity from the reference but pose/expression/setting from the description — this brings the API-key path to parity with the codex path's reference conditioning (see [image-generation.md](image-generation.md), Reference conditioning). Without it, `update_portrait` on this provider would render an unrelated character rather than revising the existing one.

A 200 response carrying no image bytes is treated as transient and retried up to 3 attempts (mirroring the codex path's empty-render retry); a thrown error is terminal, since the SDK already retries transient network / 5xx on its own.

## Rate-limit usage tracking

The provider parses OpenAI's `x-ratelimit-*` response headers (per-minute request and token rate limits) into the generic `UsageStatus` shape the Connections UI renders, exposed via `getUsageStatus()` — mirroring the anthropic provider's `anthropic-ratelimit-*` handling and using the same warning/critical thresholds. Capture happens on the **non-streaming** chat paths only: the SDK's `responses.stream()` helper doesn't surface the raw HTTP response, so the snapshot refreshes off non-streaming calls (the health check and subagent `chat()` calls), not the DM's streamed turn. A header-less or malformed response leaves the prior snapshot intact, so a stray response can't blank the UI between turns.

Unlike codex (which pushes fresh limits via JSON-RPC notifications), this is poll-style — segments are tagged `liveUpdates: false` and there is no `subscribeUsage`, matching anthropic. NOTE: these are *rate* limits (RPM/TPM headroom on the current minute), not a plan-usage window — the most an OpenAI API key exposes. OpenRouter and custom endpoints that omit the headers simply show no usage line.
