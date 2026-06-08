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
- **The bytes arrive two ways — inline, and on disk.** Codex emits an `item/completed` with `type: "imageGeneration"` whose `result` field holds the raw base64 PNG, **and** writes the same PNG under `<codexHome>/generated_images/<sessionId>/`. The inline path is the zero-I/O fast path (`extractGeneratedImage` reads `result` + `revisedPrompt`), but that `item/completed` line is multi-MB of base64 on a *single* newline-delimited JSON record, and a render's worth of bytes (2–3 MB PNG → ~3–4 MB base64) can be **dropped or corrupted on the stdio pipe** — `JSON.parse` then throws and the line is discarded, so the turn "completes" having emitted nothing we caught, even though the GPU work succeeded and the file is on disk. The robust fix is to fall back to **reading the PNG off disk** from that per-session dir (`readNewestPngAsBase64`): the dir is keyed by the ephemeral render thread's unique `sessionId` (learned from `thread/start`; the dir base is `codexHome` from the `initialize` handshake), so the newest PNG in it is unambiguously this render's, with no race against concurrent renders. This is no longer a copy we ignore — it's the canonical source when the wire drops the inline bytes. (Confirmed: a complete, valid 2.16 MB PNG landed on disk at the exact moment our inline harvest reported "no data.") Once the bytes are in hand, `renderImageOnce` deletes that per-session dir in its `finally` (`removeGeneratedImageDir`, best-effort/never-throws) — we persist our own copy into the campaign, so codex's copy is pure redundancy that would otherwise accumulate ~2–3 MB per render forever.
- **Tightly scoped.** The turn runs `sandbox: "read-only"` with terse `developerInstructions` ("call image_gen once, no shell, no file ops, no prose"). Without this the model treats the request as a coding task and wastes a round trying to `Copy-Item` the file to satisfy "save it" phrasing (harmless under read-only, but slow).
- **Nested-turn safe.** `generateImage` runs *while the DM turn that called `generate_image` is paused* awaiting our tool reply. Codex processes the two threads independently over the JSON-RPC pipe, so the inner render turn completes and the outer turn resumes — no global serialization / deadlock.
- **Knobs are best-effort, but real.** The built-in `image_gen` tool takes no explicit size/quality params over the wire — codex leaves them unset, so the backend runs at `auto` and infers both from the prompt. That makes the prompt the only lever, but a working one: `buildImagePromptText` folds `aspect` (orientation) and `effort` (a per-level quality + speed directive, `EFFORT_GUIDANCE`) into the text. The `quality`/`showcase` directives deliberately tell the model *not* to engage gpt-image's slowest maximum-fidelity pass — that "ultra" mode is where renders balloon to multiple minutes, and ordinary play should never block on it. `effortUsed`/`aspectUsed` echo the *requested* values.

## Abstract knobs

`packages/engine/src/providers/types.ts` defines two abstract enums the model picks from:

- **`ImageEffort`** = `"draft" | "standard" | "quality" | "showcase"`. Per-provider mapping; on the API-key path this maps to `quality: "low" | "medium" | "high" | "high"`, and on the ChatGPT/codex path to natural-language steering. `draft` is the floor; there is no lower tier. Both paths steer `quality`/`showcase` short of gpt-image's slowest pass (see [Provider backends](#provider-backends)).
- **`ImageAspect`** = `"portrait" | "landscape" | "square"`. Use-case-named, not pixel-named — `portrait` is character close-ups, `landscape` is scenes, `square` is objects.

The setup-agent passes `effort: "standard"` for chargen portraits — medium quality is the ceiling a character card needs, and it's fast enough to iterate on. The DM defaults to `quality` (high quality at a reasonable render time) for scene snapshots and player-requested illustrations, drops to `standard` for quick/minor inserts, and reserves `showcase` for rare set-piece hero shots (`packages/engine/src/prompts/dm-directives.md`).

## Reference conditioning (image-to-image)

The DM can ask a render to **match a player character's established look** by naming them in the `generate_image` tool's optional `reference_characters` array (a list of character names). The named characters' portraits are fed to the renderer as image-to-image references so the depicted character comes out on-model (face, build, outfit) instead of a fresh invention.

**Opt-in, never default.** A portrait reference biases the *whole* render toward that character, which is wrong for a wide scene they're barely in (or not in at all) — so references are attached only when the DM explicitly lists names. The tool description steers the model to use it only when a specific PC is clearly the subject and their likeness matters, and to leave it off for crowds/scenery.

**Name → portrait resolution** (`loadCharacterReferences` in `packages/engine/src/agents/dm-portraits.ts`, called from `GameEngine.dispatchGenerateImage`): each name maps through `slugify` to `<campaignRoot>/characters/<slug>-portrait.png` — the *same* file `loadDmPortraitMessage` injects into the DM's context. Resolution is deliberately forgiving: names with no portrait on disk (an NPC, a PC whose player declined image gen, a typo) are skipped silently, deduped by path, and an all-miss list omits the field entirely so a plain text-to-image render happens. So a bad name degrades to "no reference," never an error.

**Transport** (`openai-chatgpt` / codex): each resolved portrait rides as an `image` input item *ahead of* the text prompt on the render turn, and `buildImagePromptText` appends a directive naming the referenced characters ("…the established appearance of X — match that character's face, build, and outfit to the reference, but follow this description for pose, setting, and framing"). Codex's `image_gen` then conditions the render on them. **Validated**: a reference render reproduced a PC's distinctive features (hair, freckles, hex-pattern pauldron, outfit) in a brand-new scene the prompt described from scratch, where the no-reference control was an unrelated character.

**Cost / caveats.** Image-to-image is materially slower than text-to-image (gpt-image-2 backend cost — a reference render is minutes, vs. roughly a second for plain text-to-image). Earlier the renderer instruction told the model to "match each character's face to their reference," which sometimes made it spend a reasoning pass *analyzing* the attached portrait and then reply with text instead of calling `image_gen` at all (a wasted multi-minute attempt the bounded retry rescued). #596 reframed the instruction — references are consumed by `image_gen` automatically, so the model is told *not* to view/analyze them, its only job is to call the tool once — and a live 8-render reference batch afterward showed **0 text-replies (8/8 first-attempt images, avg 1.00 attempts)** while conditioning still held (the depicted character stayed on-model). The bounded retry (see [Provider backends](#provider-backends)) stays as the safety net for the residual intermittent case. Lowering the render turn's reasoning effort would be the other lever, but `"low"` is the **floor** — the backend rejects `image_gen` at `reasoning.effort: "minimal"` (HTTP 400), so it isn't available. Net: references work and come out on-model, but each render is minutes — reserve them for deliberate "show *this* character" moments. To re-measure the first-attempt rate after any renderer-instruction or effort change, run the probe: `node --import tsx/esm packages/test-harness/bin/ref-render-rate.ts` (issue #599).

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

**Sizing.** The parent (`NarrativeArea`) passes **bounds** — the full content width and a height cap that's a fraction of the narrative viewport keyed off the image's **intent** (`imageHeightCapFraction`: character portraits `0.6`, scene snapshots / player requests `0.9`) — not a fixed footprint. Portraits are tall and would otherwise dominate the pane, so they get the smaller slice; scenes are the focus of the moment and get nearly the whole pane. `InlineImage` reads the image's true dimensions (sharp metadata, header-only) and `fitImage` (`geometry.ts`) reserves exactly the scaled footprint at the image's real aspect: landscapes fill width, portraits fill height up to the cap. Cell aspect (cells are ~2:1 tall:wide) is folded into the math so a square image reads square on screen. This replaced an earlier scheme where the parent reserved a 16:9 box and the component `fit:contain`-ed into it — that letterboxed twice (parent box + component padding) and needed an `isPortrait`/`intent` hack to special-case tall portraits. There's one reflow when metadata lands (a wide default holds the slot until then, so non-portrait images don't move).

**Composition.** The image decodes + resizes once (sharp), then a painter registered with the sync-write combiner re-blits the visible band inside the same DEC-2026 synchronized-output frame Ink just drew — flicker-free. The painter is the **single authority for both position and pixels**, and it runs at the only correct moment: the combiner splices it in just before ESU, which Ink emits from `onRender` *after* `calculateLayout()`. So the painter measures the slot's on-screen row fresh each frame and reads the row for the frame being drawn. (Measuring in a `useLayoutEffect` instead — React's commit, *before* Ink lays out — lags one frame: invisible on a 1-row scroll, but a multi-row PgDn jump paints the image a full page behind the text and strands it there once the scroll settles. So there's no layout-effect repositioning, and `NarrativeArea` no longer threads a changing prop to break the image line's `React.memo` — the painter, which runs every Ink frame regardless, re-measures and re-clips itself, which also drops the per-tick re-render of off-screen image lines.) `visibleBand` clips the footprint to the narrative viewport, so the image never overflows the modeline above or the input line below — this **partial (vertical) crop is for the viewport's top/bottom edges only**. The band re-encodes in-frame whenever its identity changes (cheap for all drivers — sixel/iTerm2/kitty are all real-time) and reuses the cached payload when it hasn't, so a static image never re-encodes.

Modal occlusion is **all-or-nothing**: the painter reads the live occluder spans (`OcclusionProvider` / `useRegisterOcclusion`, registered by `CenteredModal` + `OverlayPane`) and hides the whole image if any span overlaps its band, restoring it when the modal closes. The hide/show is **edge-triggered** via `useOcclusionChange`: the registry notifies subscribers on every register/unregister, and the image schedules a (deferred, coalesced) repaint. This is deliberate — sixel blits are slow and Ink frames get dropped, so relying on the frame for that exact render to carry the occlusion change misses the edge (the image hid on the first modal open, then stayed stranded over the modal on later opens). The deferral lands the repaint after the modal registered its span (no flash); the coalescing caps it to one write per burst. The inline `ChoiceOverlay` registers no span, so it leaves the image visible. (Partial *modal* cropping — showing the rows a modal leaves free — was built and removed: interior splits and re-encode timing weren't worth the complexity for a transient overlay.) The painter's vacated-row erase is passed the occluder spans and **skips any row a modal owns** — otherwise the erase, fired the instant a modal covers the image, would blank the modal where the image had been (the "modals hidden by image" bug).

## Visual style guidance

Style direction for `generate_image` prompts lives in the `<Image>` include at `packages/engine/src/prompts/include/Image.md`, pulled into `dm-directives.md` via `<!--include:Image-->`. The default block defines the campaign-wide art direction; campaign seeds can override via the `processIncludes` cascade either by selecting a named variant (`<!--include:Image.VariantName-->`) or by redefining `<Image>...</Image>` inline. Setup-agent portraits don't use the include — they hardcode a neutral "simple digital art, plain black background" style so the portrait can serve as a consistent visual reference for the DM in any campaign's art direction.

PC portraits are injected into the DM's context as `image_input` ContentParts in the non-ephemeral cached prefix via `loadDmPortraitMessage` (`packages/engine/src/agents/dm-portraits.ts`) — the model has a visual reference for each PC's appearance without any per-turn token cost beyond the initial cache write (~85 input tokens per image with `lowDetail`).

Both DM-tier providers transmit these `image_input` parts to the model: `openai.ts` (`toResponsesInput`) emits Responses-API `input_image` items, and `openai-chatgpt`'s `messageToResponsesItems` does the same for the codex `thread/inject_items` replay. One codex-specific gotcha: its Responses deserializer accepts only `detail: "high" | "original"` (it rejects the OpenAI SDK's `"low"`/`"auto"` outright), so `messageToResponsesItems` maps `lowDetail → "high"` (codex's downscaled floor) and full-detail → `"original"`. Whether the DM actually *uses* the portrait in a generated scene is left entirely to the model — no prompt directive pushes the PC into images.

## Disk + transcript

All generated bytes land in `<campaignRoot>/campaign/images/` (or `<setupRoot>/campaign/images/` during chargen). The basename is keyed off the image's intent (see `pickBasename` in `image-handler.ts`):

| Intent | Basename pattern |
|---|---|
| `scene_snapshot` | `scene-NNN-<scene-slug>-<timestamp>.png` |
| `player_request` | `request-<timestamp>.png` |
| `character_portrait` | `portrait-draft-<timestamp>.png` (setup-agent only; on `set_portrait` the chosen draft is copied to `<setupRoot>/characters/<character-slug>-portrait.png` — inside the `__setup__` scratch campaign, not the real one) |

Each image gets a `.json` sidecar alongside it with `id`, `intent`, `timestamp`, `mimeType`, optional `sceneNumber` / `sceneSlug`, and the OpenAI `revisedPrompt` if the provider returned one. The sidecar is never load-bearing for rendering — it exists purely as an audit record for debugging.

### Portrait handoff at campaign creation

`set_portrait` does **not** write into the live campaign. During chargen the setup agent runs against a `__setup__` scratch campaign, so `dispatchSetPortrait` (`setup-conversation.ts`) copies the chosen draft from `<setupRoot>/campaign/images/<draft_filename>` to `campaignPaths(setupRoot).characterPortrait(name)` — i.e. `<setupRoot>/characters/<character-slug>-portrait.png`, still inside the scratch tree. (It sanitizes `draft_filename` to a bare basename and `mkdir`s `characters/` first, since the scratch tree starts minimal.)

The transfer into the real campaign happens later, inside `buildCampaignWorld` (step 9, `packages/engine/src/agents/world-builder.ts`). After scaffolding the new campaign directory, it reads `<campaignsDir>/__setup__/characters/<character-slug>-portrait.png` and, if that file exists, writes the bytes to the new campaign's `characterPortrait` path (`<campaignRoot>/characters/<character-slug>-portrait.png`). If the source is absent — the no-portrait case, where the player declined image generation or `set_portrait` was never called — the copy is silently skipped and the campaign starts without a portrait; the failure path inside the copy is likewise non-fatal. This copy is the bridge between the setup-agent's chargen path and the gameplay path: `loadDmPortraitMessage` in `dm-portraits.ts` reads the very same canonical `characterPortrait` location to inject the PC's likeness into the DM's context, so when the source file is missing it simply finds nothing to inject.

HTML transcript export (`packages/client-ink/src/commands/transcript.ts` — `loadImageBytes` + `buildTranscriptHtml`) reads each referenced PNG and embeds it as a `data:image/png;base64,...` URI inline in the output HTML. The exported file is fully self-contained — no sidecar PNGs, no external links, full on-disk quality. Missing files (moved/deleted between gameplay and export) degrade gracefully to `[image unavailable]` placeholders.

Once `buildTranscriptHtml` has produced the HTML string, the client persists it via `PUT /session/transcript` (`saveTranscript` in `packages/client-ink/src/api-client.ts`). The route — implemented in `packages/engine/src/server/routes/data.ts`, mounted under the `/session` prefix — writes the body to `<campaignRoot>/game-transcript.html` through the engine's `FileIO`, same as every other campaign write. It carries a per-route `bodyLimit` of **50 MB**, explicitly overriding the server-wide 1 MB default: long campaigns (around the 60-turn mark) produce transcript HTML that exceeds 1 MB and would otherwise be rejected with HTTP **413 Payload Too Large**, silently failing to save. The override is scoped to this single route so every other endpoint keeps the tighter default.

Inlined images are clickable: a small vanilla-JS shadowbox (no dependencies) fills the viewport with the image on a black backdrop. Esc or a click on the backdrop closes it; clicks and right-clicks *on the image itself* are left to the browser so the reader can save it / open it in a new tab. The overlay scaffold (`#shadowbox` + handler) is always emitted; image elements get a `zoomable` class. The images are also keyboard/screen-reader accessible — `tabindex="0"` + `role="button"` + an `aria-label`, with Enter/Space opening the shadowbox when one is focused.

## Engine-log breadcrumbs

For harness probes + post-mortem debugging:

| Event | Where | Meaning |
|---|---|---|
| `image_gen:request` | provider | About to call the rendering API; carries effort + aspect + intent. |
| `image_gen:response` | provider | API returned; carries effort_used + aspect_used. |
| `image_gen:disk_recovery` | provider (codex) | Inline base64 was missing/dropped but the PNG was read off disk from `generated_images/<sessionId>/`. Carries `base64Length` + the dropped inline item inventory. Frequent occurrences = the stdio pipe is regularly dropping the inline bytes. |
| `image_gen:no_data` | provider | Turn completed but produced **no** bytes inline *and* none on disk. Dumps the full item inventory (types, statuses, imageGeneration `resultLen`, any text preview) so the real reason — refusal, empty result, wrong tool, empty turn — is visible. |
| `image_gen:timeout` | provider (codex) | Render turn exceeded the backstop timeout; dumps whatever items arrived before the stall. |
| `image_gen:error` | provider | API call threw. |
| `codex:rpc:parse_failure` | provider (rpc) | A **large** (≥4 KB) stdout line failed `JSON.parse` — the smoking gun for a dropped/truncated payload (e.g. inline image base64). Carries byte length, head/tail, and a salvaged `methodGuess` so a non-image drop is attributable. NOT codex tracing (that's on stderr — see `codex:subprocess:stderr`); short non-JSON stdout lines are still ignored. |
| `codex:rpc:large_line` | provider (rpc) | A ≥256 KB line that *did* parse — confirms big payloads survive the pipe intact, so a byteless render is the backend's doing, not ours. |
| `codex:subprocess:stderr` | provider (rpc) | A line codex wrote to its own stderr (tracing/diagnostics), captured to the engine log instead of the terminal. The place a misbehaving render/tool turn explains itself. ANSI-stripped, length-capped; volume scales with `RUST_LOG`. |
| `codex:rpc:reasoning_item_missing` | provider | **Once/session.** Model reasoned but no `rawResponseItem/completed` reasoning item arrived (#533 replay got nothing). A transport drop, or — confirmed live — a non-ZDR ChatGPT account where codex emits no raw reasoning items at all. See [openai-chatgpt-provider.md](openai-chatgpt-provider.md#reasoning-preservation-across-turns) / #597. |
| `image_gen:persisted` | image-handler | Bytes written to disk; carries relPath + size. |
| `image_gen:dispatch_failed` | setup-conversation, game-engine | Caller couldn't dispatch (no capability, empty prompt, etc.). |
| `image_gen:legacy_hosted_item_ignored` | provider | Tripwire — see Tool dispatch above. |
| `setup:image_tools_registered` | setup-conversation | Setup-agent snapshot at startup: which capability/tools/loop active. |

See [e2e-harness.md](e2e-harness.md) for how probes consume these.
