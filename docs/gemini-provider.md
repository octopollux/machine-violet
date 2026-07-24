# Gemini Provider

The `gemini` connection type uses Google's official `@google/genai` SDK and
the Gemini Developer API. It is a first-class provider for all Machine Violet
model tiers and pairs Gemini text models with Google's native image model.

## Authentication and onboarding

Add a Google Gemini connection from **Settings → API Keys → Add Connection →
Google Gemini**, then paste a Gemini Developer API key. The engine also creates
an environment-backed connection automatically from `GOOGLE_API_KEY` or
`GEMINI_API_KEY` (`GOOGLE_API_KEY` wins when both are present).

Environment connections are read-only in the UI and are never persisted to
`connections.json`. Manual keys use the same local plaintext trust boundary as
the other API-key providers.

## Model registry and defaults

The shipped stable model set is:

| Tier default | Model | Context | Max output | Standard pricing / 1M tokens |
|---|---|---:|---:|---:|
| Large | `gemini-3.6-flash` | 1,048,576 | 65,536 | $1.50 input / $7.50 output |
| Medium | `gemini-3.5-flash` | 1,048,576 | 65,536 | $1.50 input / $9.00 output |
| Small | `gemini-3.5-flash-lite` | 1,048,576 | 65,536 | $0.30 input / $2.50 output |

All three support thinking, function tools, streaming, multimodal inputs, and
implicit context caching. The registry marks image generation available because
each Gemini text connection has a paired Nano Banana renderer; the text model
does not itself produce the image.

## Interactions API

`packages/engine/src/providers/gemini.ts` uses the Interactions API, which Google
recommends for the latest models. It does not use legacy
`@google/generative-ai` or `generateContent`.

Machine Violet operates Interactions in stateless mode (`store: false`) because
the engine already owns and persists canonical conversation history. Every
request translates normalized history into Interactions steps:

- user messages → `user_input`
- assistant text → `model_output`
- tools → `function_call` / `function_result`
- Gemini reasoning → `thought`

Gemini 3.x attaches opaque thought signatures both to `thought` steps and to
some `function_call` steps. Both signatures are captured into normalized
history and replayed unchanged. Dropping a function-call signature makes the
next stateless tool-result request fail with HTTP 400.

Tool calls remain loop-style: the provider returns normalized calls to
`runProviderLoop`, Machine Violet dispatches them, then the next provider call
replays the history plus the `function_result`. The provider never executes a
tool by itself.

Streaming consumes Interactions SSE events. `step.delta` text is sent to the
TUI immediately; function arguments, thought summaries, signatures, status,
and usage are assembled into the same `ChatResult` shape as a non-streaming
call.

Gemini can attach function-call steps to an interaction whose overall status is
already `completed`. The adapter treats any function call as a tool-use stop so
the bridge executes it and requests the follow-up narration.

Reasoning effort maps directly to Gemini `thinking_level`:

| MV effort | Gemini |
|---|---|
| `low` | `low` |
| `medium` | `medium` |
| `high` / `max` | `high` |
| unset | model default |

When effort is explicit, `thinking_summaries: "auto"` is requested so visible
summaries populate `thinkingText`. Usage normalization maps input, output,
cached, and thought-token counters from the Interactions response.

## Nano Banana image generation

`generateImage()` defaults to Nano Banana 2
(`gemini-3.1-flash-image`). `GenerateImageRequest.imageModel` can override it
with another compatible Gemini image model.

The abstract image controls map as follows:

| MV value | Gemini response format |
|---|---|
| `draft` / `standard` / `quality` / `showcase` | `512` / `1K` / `2K` / `4K` |
| `portrait` / `landscape` / `square` | `2:3` / `3:2` / `1:1` |

Reference portraits are passed as image content alongside the prompt, enabling
native image editing/conditioning. The adapter returns the generated inline
bytes and actual MIME type through the normal `GenerateImageResult` contract.

## Source references

- [Interactions API](https://ai.google.dev/gemini-api/docs/interactions)
- [Latest Gemini models](https://ai.google.dev/gemini-api/docs/latest-model)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Streaming Interactions](https://ai.google.dev/gemini-api/docs/streaming)
- [Image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [`@google/genai` reference](https://googleapis.github.io/js-genai/)
