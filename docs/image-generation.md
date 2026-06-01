# Image Generation

The DM can render illustrated images inline with its responses — character portraits during setup, scene snapshots during gameplay, ad-hoc illustrations on player request. Rendering goes through whichever provider backs the `large` tier, gated by both provider capability and per-campaign consent.

## Capability + consent

Image-gen is enabled for a turn iff:

- **Provider capability** — `provider.getCapabilities(model).imageGeneration === true`. True for `openai-apikey` + `gpt-5` family (routes to `gpt-image-2` via the Images API) and for `openai-chatgpt` (routes to codex's built-in `image_gen` skill — see [Provider backends](#provider-backends)). False for everything else (Anthropic, and the Chat Completions fallback used by custom OpenAI-compatible endpoints).
- **Campaign preference** — `gameState.config.image_generation !== "off"`. The setup-agent asks the player a yes/no consent question right after world + system selection ([game-initialization.md](game-initialization.md)). The choice is stored in `config.json` and can be flipped per-campaign from the ESC menu's "Image generation" toggle.

When either is false, the `generate_image` tool is omitted from the DM's toolset and the model has no way to invoke it. There is no "graceful fallback" path on the model side — the model simply doesn't see the tool.

## Tool dispatch

`generate_image` is a **function tool** (not a hosted/server-side tool). The model calls it like any other tool; the host runs `provider.generateImage()`, persists the bytes, and attaches a `display_image` TUI command to the tool result so the image renders inline mid-turn — before the model's continuation runs.

Two call sites:

| Site | File | Purpose |
|---|---|---|
| Setup-agent portrait loop | `packages/engine/src/agents/subagents/setup-conversation.ts` (`dispatchGenerateImage`) | Character portrait drafts during chargen. Player iterates; `set_portrait` promotes a chosen draft. |
| DM gameplay | `packages/engine/src/agents/game-engine.ts` (`dispatchGenerateImage`) | Scene snapshots, character close-ups, player-requested illustrations. |

Both share `handleImageGenerated` in `packages/engine/src/agents/image-handler.ts` for on-disk persistence — same naming, same sidecar JSON, same downstream consumers.

The legacy hosted-tool path (`image_generation_call` items in the Responses API) is explicitly **not** used. The provider has a tripwire (`image_gen:legacy_hosted_item_ignored`) that fires if such an item ever shows up — see [the dispatch memory](../packages/engine/src/providers/openai.ts) for context.

## Provider backends

`provider.generateImage(req)` is the single seam the dispatchers call. Two providers implement it, with very different mechanics behind the same `GenerateImageRequest → GenerateImageResult` contract:

| Provider | Mechanism | Auth / billing |
|---|---|---|
| `openai-apikey` | One `client.images.generate({ model: "gpt-image-2", quality, size })` REST call (`openai.ts` `openaiGenerateImage`). | Platform API key + credits. |
| `openai-chatgpt` | Drives a **scoped codex turn** that calls codex's built-in `image_gen` skill, then harvests the `imageGeneration` item codex emits (`provider.ts` `generateImage`). | ChatGPT subscription — **no API key**; billed to the plan's Codex allocation. |

The `openai-chatgpt` path is the happy path for most users (sign in with a ChatGPT subscription, no metered API spend). There is **no fallback** between providers: a ChatGPT-account DM never silently routes image-gen to a metered API-key provider. If the codex render fails, the dispatcher returns an `isError` tool_result the DM recovers from — it does not escalate to a more expensive backend.

Why the codex path looks the way it does (all spike-confirmed on codex 0.133.0):

- **No direct RPC for image_gen.** It's a model-driven skill, not an app-server method. So `generateImage` issues its own `thread/start` + `turn/start`, separate from the DM's conversation thread, asking the model to render the prompt.
- **The bytes arrive inline.** Codex emits an `item/completed` with `type: "imageGeneration"` whose `result` field holds the raw base64 PNG (it also writes a copy under `~/.codex/generated_images/`, which we ignore). `extractGeneratedImage` reads `result` + `revisedPrompt`; the on-disk copy is never load-bearing.
- **Tightly scoped.** The turn runs `sandbox: "read-only"` with terse `developerInstructions` ("call image_gen once, no shell, no file ops, no prose"). Without this the model treats the request as a coding task and wastes a round trying to `Copy-Item` the file to satisfy "save it" phrasing (harmless under read-only, but slow).
- **Nested-turn safe.** `generateImage` runs *while the DM turn that called `generate_image` is paused* awaiting our tool reply. Codex processes the two threads independently over the JSON-RPC pipe, so the inner render turn completes and the outer turn resumes — no global serialization / deadlock.
- **Knobs are best-effort.** The built-in `image_gen` tool takes no explicit size/quality params over the wire, so `effort`/`aspect` are folded into the prompt text (`buildImagePromptText`) as natural-language steering rather than hard parameters. `effortUsed`/`aspectUsed` echo the *requested* values.

## Abstract knobs

`packages/engine/src/providers/types.ts` defines two abstract enums the model picks from:

- **`ImageEffort`** = `"draft" | "standard" | "quality" | "showcase"`. Per-provider mapping; on OpenAI this maps to `quality: "low" | "medium" | "high" | "high"`. `draft` is the floor; there is no lower tier.
- **`ImageAspect`** = `"portrait" | "landscape" | "square"`. Use-case-named, not pixel-named — `portrait` is character close-ups, `landscape` is scenes, `square` is objects.

The setup-agent always passes `effort: "draft"` (player iterates, needs fast turnaround). The DM defaults to `standard` for scene snapshots and is told to reserve `quality` / `showcase` for set-piece moments (`packages/engine/src/prompts/dm-directives.md`).

## Mid-turn render

The bridge dispatches all of a turn's tool calls concurrently via `Promise.all` (`packages/engine/src/providers/agent-loop-bridge.ts`). Tool results carrying a `_tui` field broadcast their TUI command immediately rather than queuing until end-of-turn. `generate_image` returns `_tui: { type: "display_image", filename, relPath, intent }` so the image appears inline as soon as the bytes are written — same pattern as `style_scene` returning `_tui: set_theme`.

The bridge's `_tui` extraction is gated on `tuiToolNames.has(toolName)` — tools not in `TUI_TOOLS` (`packages/engine/src/agents/agent-loop.ts`) have their `_tui` field silently ignored. `generate_image` is in the set; removing it would cause images to land on disk but never render in the client, with no error anywhere. A regression test in `agent-loop.test.ts` guards against this.

DM prompt guidance instructs the model to fire `generate_image` in the **same parallel tool batch** as `scene_transition` and `style_scene`, never sequenced before — otherwise the player waits for the (potentially slow) render before any narrative arrives.

Crucially, the guidance points a scene-transition image at **the DM's favorite moment from the scene that *just finished***, not the scene being entered. At the boundary turn the departing scene's full transcript is still alive in the model's context (the transition's compaction runs *after* the agent loop, so the rich detail hasn't been pruned yet), whereas the entering scene is still nothing but a title. Aiming the image at the departing scene is what gives it the context to be good. This is also why a transition image files under the *departing* scene's `scene-NNN-slug`: `dispatchGenerateImage` reads `sceneManager.getScene()` before the deferred transition fires, so the image is correctly named for the scene it depicts.

## Inline rendering (TUI)

The client draws `display_image` lines inline with an MV-owned renderer (`packages/client-ink/src/tui/image/`), which replaced `ink-picture`. Terminal graphics protocols paint pixels out-of-band at absolute screen positions with no clipping and no z-ordering against Ink's text grid, so the renderer owns composition with the live, scrolling, layered TUI.

**Protocol selection.** At startup `start-client.ts` probes the terminal (`detectGraphicsCapabilities` in `tui/image/capabilities.ts`) and picks the best of three real graphics protocols — **kitty > iTerm2 > sixel** (`pickProtocol`). The detection path is layered: pure per-query parsers → a pure assembler → a declarative `TERMINAL_QUIRKS` table → `pickProtocol`. Per-terminal workarounds are one table entry each (e.g. iTerm.app's partial kitty emulation is suppressed in favor of its native protocol). A terminal with **no** graphics protocol renders nothing inline — the image still exists at full resolution in the HTML transcript export (see Disk + transcript).

**Drivers** (`tui/image/drivers/`) implement a small `ImageDriver` interface in two families:

| Protocol | Family | Mechanism |
|---|---|---|
| kitty | placement | transmit raw RGBA once by image id, display any band via a native source-rect crop; true-color, flicker-free re-place |
| iTerm2 | blit | per-band PNG (`OSC 1337`), sized in **cells** so it lands on the text grid; true-color |
| sixel | blit | per-band, one shared quantized palette (no requantize-on-scroll); **alpha flattened to opaque before quantizing** — a transparent letterbox otherwise scatters the whole palette into noise |

**Composition.** The image decodes + resizes once (sharp), then a painter registered with the sync-write combiner re-blits the visible band inside the same DEC-2026 synchronized-output frame Ink just drew — flicker-free. Only the rows inside the narrative viewport are encoded (vertical crop), so the image never overflows the modeline above or the input line below. An overlapping modal's registered row-span hides the band (`OcclusionProvider` / `useRegisterOcclusion`, registered by `CenteredModal` + `OverlayPane`); an overlay that doesn't cover it (the inline `ChoiceOverlay`) leaves it visible.

## Visual style guidance

Style direction for `generate_image` prompts lives in the `<Image>` include at `packages/engine/src/prompts/include/Image.md`, pulled into `dm-directives.md` via `<!--include:Image-->`. The default block defines the campaign-wide art direction; campaign seeds can override via the `processIncludes` cascade either by selecting a named variant (`<!--include:Image.VariantName-->`) or by redefining `<Image>...</Image>` inline. Setup-agent portraits don't use the include — they hardcode a neutral "simple digital art, plain black background" style so the portrait can serve as a consistent visual reference for the DM in any campaign's art direction.

PC portraits are injected into the DM's context as `image_input` ContentParts in the non-ephemeral cached prefix via `loadDmPortraitMessage` (`packages/engine/src/agents/dm-portraits.ts`) — the model has a visual reference for each PC's appearance without any per-turn token cost beyond the initial cache write (~85 input tokens per image with `lowDetail`).

## Disk + transcript

All generated bytes land in `<campaignRoot>/campaign/images/` (or `<setupRoot>/campaign/images/` during chargen). The basename is keyed off the image's intent (see `pickBasename` in `image-handler.ts`):

| Intent | Basename pattern |
|---|---|
| `scene_snapshot` | `scene-NNN-<scene-slug>-<timestamp>.png` |
| `player_request` | `request-<timestamp>.png` |
| `character_portrait` | `portrait-draft-<timestamp>.png` (setup-agent only; promoted to `<campaignRoot>/characters/<character-slug>-portrait.png` on `set_portrait`) |

Each image gets a `.json` sidecar alongside it with `id`, `intent`, `timestamp`, `mimeType`, optional `sceneNumber` / `sceneSlug`, and the OpenAI `revisedPrompt` if the provider returned one. The sidecar is never load-bearing for rendering — it exists purely as an audit record for debugging.

HTML transcript export (`packages/client-ink/src/commands/transcript.ts` — `loadImageBytes` + `buildTranscriptHtml`) reads each referenced PNG and embeds it as a `data:image/png;base64,...` URI inline in the output HTML. The exported file is fully self-contained — no sidecar PNGs, no external links, full on-disk quality. Missing files (moved/deleted between gameplay and export) degrade gracefully to `[image unavailable]` placeholders.

Inlined images are clickable: a small vanilla-JS shadowbox (no dependencies) fills the viewport with the image on a black backdrop. Esc or a click on the backdrop closes it; clicks and right-clicks *on the image itself* are left to the browser so the reader can save it / open it in a new tab. The overlay scaffold (`#shadowbox` + handler) is always emitted; image elements get a `zoomable` class. The images are also keyboard/screen-reader accessible — `tabindex="0"` + `role="button"` + an `aria-label`, with Enter/Space opening the shadowbox when one is focused.

## Engine-log breadcrumbs

For harness probes + post-mortem debugging:

| Event | Where | Meaning |
|---|---|---|
| `image_gen:request` | provider | About to call the rendering API; carries effort + aspect + intent. |
| `image_gen:response` | provider | API returned; carries effort_used + aspect_used. |
| `image_gen:no_data` | provider | API returned 200 but no bytes (shouldn't happen). |
| `image_gen:error` | provider | API call threw. |
| `image_gen:persisted` | image-handler | Bytes written to disk; carries relPath + size. |
| `image_gen:dispatch_failed` | setup-conversation, game-engine | Caller couldn't dispatch (no capability, empty prompt, etc.). |
| `image_gen:legacy_hosted_item_ignored` | provider | Tripwire — see Tool dispatch above. |
| `setup:image_tools_registered` | setup-conversation | Setup-agent snapshot at startup: which capability/tools/loop active. |

See [e2e-harness.md](e2e-harness.md) for how probes consume these.
