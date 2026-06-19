# Authoring visual styles (the `.mvstyle` style catalog)

How to grow the `generate_image` visual-style catalog — the anti-tic levers, the
render-and-eyeball loop, and the banking checklist. Read this before adding or
editing a style variant.

Companion docs: [image-generation.md](image-generation.md) (the rendering and
inline-display pipeline), [seed-authoring.md](seed-authoring.md) (the
no-artist-imitation rule, which applies to every style line here).

## What this is and where it lives

- **The catalog** — `packages/engine/src/prompts/include/Image/`, one `.mvstyle`
  file per style (OKF: YAML frontmatter + `# Direction` / `# Style` / `# Notes` /
  `# Example` sections; parser is [`okf.ts`](../packages/engine/src/prompts/okf.ts)).
  A seed selects one with `<!--include:Image.Tag-->`, which the directory-backed
  loader resolves to `Image/Tag.mvstyle` and emits as an `<Image>` block — only
  the DM-facing `# Direction` + `# Style` reach the DM (frontmatter, `# Notes`,
  `# Example` never do). Dotless `<!--include:Image-->` is the default
  (`Image/Image.mvstyle`), the campaign-wide art direction; a variant overrides
  it via the `processIncludes` cascade. The catalog index + tag vocabulary live
  in `Image/index.md` and `Image/TAGS.md`.
- **The gallery** — `packages/engine/src/prompts/include/ImageStyleExample/<Tag>.example.png`,
  one worked sample per variant, 1:1 with the variants. An **authoring aid only**;
  `build-dist.js` excludes the directory from the compiled binary. (Touch
  packaging → run a test build.)
- **The probe** — `packages/test-harness/bin/style-probe.ts`. One render per run,
  driving the live codex `generateImage` exactly the way the DM does.
- **The renderer** — `gpt-image-2`, via the openai-chatgpt (Codex) provider.

## The core problem: the bored-model tic

Given a style with too little to do, `gpt-image-2` develops a visible tic: it
crams reflexive fine detail into every surface and the output reads generically
"Images-V2-flavoured". The entire catalog exists to supply styles **complex
enough that the model stays busy** satisfying a constraint instead of filling
space.

### The cardinal rule: you cannot prompt around a tic by negation

"Leave generous negative space", "resist filling it", "keep areas empty" all
**fail** — they ask the model *not* to do the thing, which never addresses *why*
it does it (boredom). Do not write anti-tic instructions as prohibitions.

Instead: **give the model intrinsic, demanding process work, and trust it.**
Over-specify the *process*, not the *restraint*. The "work" must be intrinsic to
the medium. (This is image-gen-specific and is the *opposite* of the DM-text rule
in [seed-authoring.md] / the prompting conventions, where escalating `MUST`/`EVEN
IF` directives signal an upstream conflict to fix. `gpt-image-2` genuinely needs
demanding process over-specification; the DM does not.)

## The anti-tic levers (the toolkit)

Each lever is a *positive* structural fact about a medium, never a negation. Reach
for the one that fits; compose several.

1. **Constrain the medium.** A hard material limit forces simplification.
   *Examples:* the Amiga "only 4–6 bitplanes / 16–64 indexed colours" cap forces
   visible ordered dithering (`Adventure90s`); "the printing is the medium — the
   press lays only tiny dots" forces a halftone screen (`NinetiesComic`,
   `Risograph`); "the carving is the constraint" forbids fine detail (`Woodcut`);
   "the cheap reproduction destroys fine detail" so only bold line survives
   (`PulpInk`).

2. **Deep-black rest.** A medium that falls to true black gives rest *for free*
   and carries dread at the same time — nothing lit means nothing to cram.
   *Examples:* the CRT black level (`TrinitronCRT`); a single hard flash falling
   to depthless black (`LandCamera`, `SurvivalHorror`); white lines scraped from a
   solid black ground (`Scratchboard`); an IR cone / cold thermal field collapsing
   to black (`NightVisionCam`, `ThermalCam`). Dark-ground images also composite
   cleanly into the dark TUI instead of floating in a bright rectangle.

3. **Density as a feature.** When the medium *justifies* density, lean into the
   cram rather than fighting it. *Examples:* the maximalist riso gig-poster
   (`Risograph`); a teeming hand-coloured hellscape woodcut (`Blockbook`).

4. **Photo-of-a-real-object (the craft-medium-photo thesis).** For an
   out-of-distribution craft medium, frame it as **"a PHOTOGRAPH of a real
   physical X"**, not "an X-style illustration", and lean on the medium's
   structural lever (weave, tesserae, woodgrain). This forces genuine material
   compliance *including the figure*, where an in-distribution medium just gets
   painted. *Examples:* `Tapestry` (real woven wool), `Mosaic` (real tesserae),
   `Ukiyoe` (a real printed sheet). See also lever 9.

5. **Route, don't fight.** The model reliably *won't* do some things — e.g. it
   will not convincingly tile a face; it drops the tiling and paints it. Don't ask
   it to. Give the resistant element a *real* medium it *will* do and make that
   part of the design. *Example:* `Mosaic` renders the ground in tesserae but the
   figures as cloisonné enamel, so the painted face becomes intentional.

6. **Medium, not content.** A style line must describe the **medium**, not the
   content or mood. Content words make a style scene-coupled and can smuggle a
   subject into every render. *Example:* an early `Blockbook` cut hard-coded
   "blockbook of Hell … infernal" and would have injected demons into any scene
   (a real latent bug). Keep style lines about the medium; let the scene supply
   content.

7. **Structural pattern vs blocky compression.** Naming a *regular structural
   pattern* (a halftone screen, scanline interlacing, sensor grain, ordered
   dithering) renders — the model can lay it down. Naming *chunky DCT
   macroblocking* does **not** — it renders clean fine grain instead. *Example:*
   `ThermalGrain` got its interlacing + grain by asking; `NightVisionCam` could
   not get chunky 8×8 macroblocks the same way (that needs a structural trick — a
   tiny low-res feed heavily upscaled).

8. **Grounding by degradation.** What makes a "footage" still read as **real**
   rather than a clean "video-game still" is the **low quality, not the framing**.
   Push hard on cheap-JPEG / low-resolution / washed-colour degradation. *Example:*
   `TrafficCam` and `StreetCam` share a high-pole night-road vantage, but the
   aggressive cheap-feed degradation flips `TrafficCam` from cinematic to a
   genuine DOT-cam grab. A side effect worth using: heavy degradation **dissolves
   a figure's likeness**, making it an *anonymous-menace* lens (the same end as
   thermal's heat-blur, by a different mechanism).

9. **In-distribution resistance.** A style only responds to a lever if it is
   specific / out-of-distribution enough that the model can't autopilot. A generic
   "Old Master oil painting" is so in-distribution the model coasts on its default
   photoreal render and the tic stays put (rejected). Leaded stained glass is too
   in-distribution even for the photo-of-a-real-object lever (parked). When a
   painting/illustration style fails, **suspect "too in-distribution" before
   "wrong lever."** The wins are all distinctive processes.

## Captions are mandatory, and best when native to the medium

**Every style must declare a caption directive.** The best captions are intrinsic
to the medium rather than bolted on: a film-still subtitle, a tapestry *titulus*,
a noir caption box, a broadsheet block-letter line, a burned-in camera OSD, a
vehicle-UI bar.

**The surveillance-cluster OSD codification — time only, never a date.** A burned-
in timestamp is a natural caption, but a *date* stamp pins the footage to a real
calendar year and breaks immersion the moment a seed is not present-day (a fantasy
keep or a far-future station showing `2025-05-24` is jarring). So clocked cameras
show a 24-hour `HH:MM:SS` **time only**, and a zone/location label does the place-
naming. This reads as surveillance in any era.

## Scene-coupled variants

Most variants are scene-independent — append the style line to any brief. A few
are *scene-coupled*: the look depends on how the DM composes the **subject**.
`NurseryWatercolor` (the airy white-page look) only works if the subject is
**starved** — one figure and a prop or two, no environment — or the model paints
it edge-to-edge.

The steering for a scene-coupled variant must live in the **DM-facing intro
prose** above the style line, because:

- `%%` maintainer notes are deleted by `stripComments` (`load-prompt.ts`) before
  the DM ever sees them, and
- the style line is appended **last**, after the brief is already written, so it
  is read by the image model, not the DM — it cannot un-overload a brief.

Frame the DM directive **positively** ("describe a spare subject"), never as
"don't overload" (the same anti-negation rule as the tic levers).

## How a seed uses styles: clusters and the menu-of-lenses model

A seed need not wire in a *single* style. Because it is just prompt text, a seed
can offer a **menu** of variants and let the DM pick per moment — e.g. an urban-
paranoia seed offering six different surveillance "cameras". The goal is **deep
clusters** (families of related variants the DM draws from), not one style per
seed. The surveillance cluster (`NightVisionCam`, `ThermalCam`, `ThermalGrain`,
`BackupCam`, `StreetCam`, `TrafficCam`) is the first.

**Two usage tiers:**

- **AAA-tier subset** — a small set used as *campaign-wide* art direction,
  player-switchable. Storybook, PracticalMiniature, PulpInk, GildedVellum/Fresco
  are strong candidates.
- **The broader library** — the elaborate craft-medium and one-off styles
  (`Mosaic`, `Tapestry`, `Blockbook`, the surveillance cluster, …) are *not* meant
  to skin a whole campaign; the DM grabs one **at will** for a single image of
  flair (a legend, a prophecy, a relic, a vision). Don't judge an elaborate style
  by "would you run a whole campaign in it."

*(Wiring styles onto seeds is deferred — no seed currently selects a variant.)*

## Practical constraints

- **Gameplay aspect is landscape.** In-game scene snapshots are landscape, so
  render gameplay-scene styles **wide** (`--aspect=landscape`). Don't bank a
  gameplay style as a portrait.
- **Dark grounds compose better** in the TUI (see lever 2).
- **No artist imitation.** Describe technique, tradition, and era generically
  (Byzantine mosaic, ukiyo-e tradition, late-medieval woodcut) — never name a real
  artist. A named work can be private user↔Claude shorthand, but translate it to
  descriptive technique/mood before it reaches the repo. See
  [seed-authoring.md](seed-authoring.md).

## The workflow loop

Author **one style at a time**, eyeballed by a human before banking.

1. **Design the style line** using the levers above. Describe subject /
   composition / lighting / mood first; the style line goes **last** and ends with
   a **caption directive**.

2. **Render it** with the probe (one render per run; multi-minute; real
   ChatGPT-plan spend):

   ```bash
   node --import tsx/esm packages/test-harness/bin/style-probe.ts \
     --style="<full style line, ends with a caption directive>" \
     [--scene="<subject/composition>"] \
     [--reference-label=Xera | --no-reference] \
     --effort=quality --aspect=landscape --label=<slug>
   ```

   - Drives the live codex `generateImage` against the openai-chatgpt connection
     in the dev config dir (`connections.json` at the repo root).
   - **Include the PC reference in test shots** (the probe defaults to a baked-in
     Xera portrait — do *not* pass `--no-reference`, and name the figure Xera in
     the scene). Testing every lens on the same character is the menu-on-one-
     character demo, and it surfaces how each style handles likeness.
   - Output: `.style-samples/<label>.png` (gitignored).
   - On Windows, pass `--style` / `--scene` via a single-quoted PowerShell
     here-string (`@'…'@`) so apostrophes and em-dashes survive.

3. **Show it to the user and wait for their verdict** (the show-before-bank rule).
   Do **not** pre-bank on your own read that "this is clearly good" — making
   images for humans means the human eye is the comparator, and it catches things
   you miss (a scratchboard that read pointillist, an over-saturated backup cam).
   - To check fine texture invisible at full scale (halftone, dither, interlace,
     grain, macroblocking), **zoom-verify**: crop a region and 4× nearest-neighbour
     upscale (PowerShell `System.Drawing`), then inspect.

4. **Iterate** on the user's eye until they approve.

5. **Bank it** (only after approval):
   - Add an `Image/<Tag>.mvstyle` file: frontmatter (`type: visual-style`,
     `title`, `rating`, `description`, `tags`, `made-for-model`), then a
     `# Direction` line (the DM-facing intro), a `# Style` section with the
     backtick **style line verbatim**, and a `# Notes` section recording *which
     lever does the work, why it works, and what must not be trimmed* (the
     successor to the old `%%` note — `# Notes` never reaches the DM). Link
     related styles with `[Other](./Other.mvstyle)`.
   - Copy the **approved** render to `ImageStyleExample/<Tag>.example.png` and
     reference it from the `# Example` section.
   - Add the variant to the list in [image-generation.md](image-generation.md)
     and the row in `Image/index.md`.

6. **Verify and commit.** Confirm the loader resolves it —
   `processIncludes("<!--include:Image.<Tag>-->")` (from `process-includes.ts`)
   emits the `<Image>` block with your Direction + Style and no `# Notes`. The
   OKF parser is `parseOkf` in `prompts/okf.ts`. Commit. **Push and open a PR
   only when the user asks.**

This catalog is offline content — no API, network, or golden tapes are involved,
so there is no replay/record step. Never hand-edit a rendered sample; re-render
it.
