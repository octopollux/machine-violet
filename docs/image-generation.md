# Image Generation

The DM can render illustrated images inline with its responses — character portraits during setup, scene snapshots during gameplay, ad-hoc illustrations on player request. Rendering goes through whichever provider backs the `large` tier, gated by both provider capability and per-campaign consent.

## Capability + consent

Image-gen is enabled for a turn iff:

- **Provider capability** — `provider.getCapabilities(model).imageGeneration === true`. Currently true for `openai-apikey` + `gpt-5` family (which routes to `gpt-image-2` for the actual render) and false for everything else.
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

## Abstract knobs

`packages/engine/src/providers/types.ts` defines two abstract enums the model picks from:

- **`ImageEffort`** = `"draft" | "standard" | "quality" | "showcase"`. Per-provider mapping; on OpenAI this maps to `quality: "low" | "medium" | "high" | "high"`. `draft` is the floor; there is no lower tier.
- **`ImageAspect`** = `"portrait" | "landscape" | "square"`. Use-case-named, not pixel-named — `portrait` is character close-ups, `landscape` is scenes, `square` is objects.

The setup-agent always passes `effort: "draft"` (player iterates, needs fast turnaround). The DM defaults to `standard` for scene snapshots and is told to reserve `quality` / `showcase` for set-piece moments (`packages/engine/src/prompts/dm-directives.md`).

## Mid-turn render

The bridge dispatches all of a turn's tool calls concurrently via `Promise.all` (`packages/engine/src/providers/agent-loop-bridge.ts`). Tool results carrying a `_tui` field broadcast their TUI command immediately rather than queuing until end-of-turn. `generate_image` returns `_tui: { type: "display_image", filename, relPath, intent }` so the image appears inline as soon as the bytes are written — same pattern as `style_scene` returning `_tui: set_theme`.

The bridge's `_tui` extraction is gated on `tuiToolNames.has(toolName)` — tools not in `TUI_TOOLS` (`packages/engine/src/agents/agent-loop.ts`) have their `_tui` field silently ignored. `generate_image` is in the set; removing it would cause images to land on disk but never render in the client, with no error anywhere. A regression test in `agent-loop.test.ts` guards against this.

DM prompt guidance instructs the model to fire `generate_image` in the **same parallel tool batch** as `scene_transition` and `style_scene`, never sequenced before — otherwise the player waits for the (potentially slow) render before any narrative arrives.

## Visual style guidance

Style direction for `generate_image` prompts lives in the `<Image>` include at `packages/engine/src/prompts/include/Image.md`, pulled into `dm-directives.md` via `<!--include:Image-->`. The default block defines the campaign-wide art direction; campaign seeds can override via the `processIncludes` cascade either by selecting a named variant (`<!--include:Image.VariantName-->`) or by redefining `<Image>...</Image>` inline. Setup-agent portraits don't use the include — they hardcode a neutral "simple digital art, plain black background" style so the portrait can serve as a consistent visual reference for the DM in any campaign's art direction.

PC portraits are injected into the DM's context as `image_input` ContentParts in the non-ephemeral cached prefix via `loadDmPortraitMessage` (`packages/engine/src/agents/dm-portraits.ts`) — the model has a visual reference for each PC's appearance without any per-turn token cost beyond the initial cache write (~85 input tokens per image with `lowDetail`).

## Disk + transcript

Generated bytes land at `<campaignRoot>/scenes/scene-NNN/images/<basename>.png` for in-game renders and `<setupRoot>/campaign/images/portrait-draft-*.png` for setup drafts. A `.json` sidecar carries the prompt + metadata.

HTML transcript export (`packages/client-ink/src/commands/transcript.ts` — `loadImageBytes` + `buildTranscriptHtml`) reads each referenced PNG and embeds it as a `data:image/png;base64,...` URI inline in the output HTML. The exported file is fully self-contained — no sidecar PNGs, no external links, full on-disk quality. Missing files (moved/deleted between gameplay and export) degrade gracefully to `[image unavailable]` placeholders.

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
