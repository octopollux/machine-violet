# TUI Design

The TUI is a single Ink (React for CLI) application. The aesthetic target is "prettier than Claude Code, not quite as crazy as Cogmind." The DM agent manipulates the UI directly via tools — there is no abstraction layer between engine and interface.

## Layout

Full layout at ≥80 columns, ≥40 rows. Elements listed bottom to top:

```
┌═══════════════════════════════════════════════════════════════════════════════┐
│                         ┌─ Conversation Pane ─┐                              │
│  ╔══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══╗     │
│  ║  HP: 42/42       The Shattered Crown        Mana: 7/12  ║     │
│  ║  ≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈  ║     │
│  ╠══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══╣     │
│  ║ ┃                                                          ┃ ║     │
│  ║ ┃  The door groans open onto a long hall lit by guttering  ┃ ║     │
│  ║ ┃  candles, the air thick with dust and something sweeter  ┃ ║  ← Conversation Pane
│  ║ ┃  underneath. At the far end, a figure sits motionless    ┃ ║  (multi-line themed frames,
│  ║ ┃  in a high-backed chair.                                 ┃ ║   DM narrative, activity line)
│  ║ ┃                                                          ┃ ║     │
│  ║ ┃──────────────────────────────────────────────────────────┃ ║     │
│  ║ ┃  Checking rules...                                       ┃ ║  ← activity line
│  ╠══ ═══ ═══ ═══ ══╡ Aldric's Turn ╞═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══╣  ← themed bottom frame
│  ║  ≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈  ║     │
│  ╚══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══ ═══╝     │
│                                                                              │
│                         ┌─── Player Pane ────┐                               │
│  ┌────────────────────────────────────────────────────────────┐              │
│  │  HP: 42/42 | Loc: The Shattered Hall | Conditions: none   │  ← modeline  │
│  │  > I approach the figure cautiously, hand on my sword      │  ← input     │
│  └────────────────────────────────────────────────────────────┘              │
│                                                                              │
│  [Aldric]  Sable  Rook(AI)                                      ← player selector
└──────────────────────────────────────────────────────────────────────────────┘
```

The layout is split into two panes:
- **Conversation Pane** — multi-line themed top/bottom frames (from `.theme` asset), themed side columns, resource display in top frame, narrative area, activity line, turn indicator in bottom frame.
- **Player Pane** — simple 1-char bordered box containing modeline + input line. Uses `SimpleBorder` (not the multi-line theme).
- **Player Selector** — sits below the Player Pane, outside both bordered sections.

### Elements

**Player selector** — Bottom row, below the Player Pane. Shows all players. Active player is highlighted. AI players marked with `(AI)`. Outside initiative, players switch with a hotkey (Tab). During initiative, the system controls who's active. Hidden in single-player.

**Player Pane** — A simple bordered box (1-char `SimpleBorder` with corners, not the multi-line theme) containing the modeline and input line. Sits between the Conversation Pane and the player selector.

**Input line** — Text input for the active player (inside the Player Pane). Tagged with the active character name before being sent to the DM: `[Aldric] I approach the figure cautiously`.

**Modeline** — Nethack-style status line (inside the Player Pane). DM-controlled via tools. Typically shows HP, location, active conditions. Content is freeform text — the DM writes whatever's relevant. The modeline also displays a running session cost in USD (e.g. `<1¢`, `37¢`, `$1.24`), updated after each exchange via the cost tracker.

**Bottom frame** — Multi-line themed border (from the active `.theme` asset). Contains the turn indicator centered in the top row: `═══╡ Aldric's Turn ╞═══`. Shows `DM` when it's the DM's turn to narrate. Height and art determined by the theme asset's `edge_bottom`, `corner_bl/br`, and `separator` components.

**Activity line** — Automatic indicators for in-flight engine operations (inside the Conversation Pane). Not DM-controlled. See [Activity Indicators](#activity-indicators).

**DM narrative text** — Scrolling text area (inside the Conversation Pane). The main content region. The DM's narration renders here. Supports inline formatting (see [DM Text Formatting](#dm-text-formatting)). Shows a scroll indicator when content overflows (e.g. `scroll (12) more`). Supports PageUp/PageDown keyboard scrolling (multi-line jumps). Auto-scrolls to the bottom when new content arrives, unless the user has scrolled up.

**Top frame** — Multi-line themed border (from the active `.theme` asset) with resource display. Shows the active character's key resources (HP + 1-2 others). See [Resource Display](#resource-display). Height and art determined by the theme asset's `edge_top`, `corner_tl/tr`, and `separator` components.

**Left and right side columns** — Multi-line themed vertical borders (width determined by the theme asset's `edge_left`/`edge_right` components). Decorative — no information content. Part of the Conversation Pane. Visible at both tiers.


## Resource Display

The top frame shows the active player's key stats. This is entirely Tier 1 — code reads the character file and renders configured values.

During character creation, the setup agent writes a `display_resources` list to the character file's front matter:

```jsonc
// characters/aldric.md front matter
{
  "display_resources": ["HP", "Spell Slots", "Ki"]
}
```

The top frame reads these keys from the character sheet, formats them, and renders. When the active player switches, the display updates automatically. Different characters in the same party can have different resource types.

The DM can update `display_resources` mid-game via a tool (e.g., a character gains a new resource type at level-up).

### Layout

Resources are split across the top frame: first resource left-aligned, campaign name centered, remaining resources right-aligned. If only one resource is configured, it's left-aligned with the campaign name centered.

```
║  HP: 42/42          The Shattered Crown         Mana: 7/12  ║
```


## Activity Indicators

The activity line shows what the engine is doing, mapped automatically from in-flight tool calls. The player sees the DM "working behind the screen."

| Engine state | Activity line | Modeline glyph |
|---|---|---|
| `roll_dice` in flight | `Rolling...` | `⚄` |
| Rule lookup subagent | `Checking rules...` | `📖` |
| `scene_transition` cascade | `Scene transition...` | `⟳` |
| Waiting for DM API response | `The DM is thinking...` | `◆` |
| Tool call in flight (`tool_running`) | `The DM is working...` | `◆` |
| Inline (player-requested) image render in flight (`generating_image`) | `The DM is creating an image...` | `🎨` |
| Setup→game handoff in flight | `Preparing your campaign...` | `◆` |
| Player's turn (idle) | *(hidden)* | *(hidden)* |

The `tool_running` row matters because subagent-backed tools (e.g. `style_scene` → theme-styler) routinely take 20-60s. ActivityLine also renders any accumulated tool glyphs even when the engine state itself has no mapped label, so a transient or unmapped state can never silently wipe the row.

`generating_image` is its own state (not just `tool_running`) because image rendering is the slowest tool by far — minutes — and deserves a clear "creating an image" message with tier escalation. It's emitted **only for the synchronous `player_request` render mode** (the player explicitly asked and is waiting in-turn); *background* renders (`scene_snapshot`/`character_portrait`) are detached and surface on a later turn, so they never raise this state (parking in it would falsely read as "DM's turn" while the player should be playing — see [image-generation.md](image-generation.md#two-render-modes-gameplay)). When an inline render is batched with faster sibling tools, the engine holds `generating_image` (via the `syncImageRenderInFlight` counter) until the render finishes — a quick sibling completing first must not drop the indicator back to `dm_thinking`. Its accumulating tool glyph is `❖` (magenta).

The modeline glyph column is used when the activity line has been dropped due to viewport size (see [Responsive Design](#responsive-design)). The glyph appears at the start of the modeline.

### Elapsed-time hints and tier escalation

For known-slow states (the first DM turn, the setup→game handoff), the activity line escalates the label after configurable elapsed-time thresholds and appends a `(Ns)` seconds counter once the wait passes ~5s. This turns a 60–90s silent wait (the cost of one giant first-turn LLM call) into visible progress instead of an ambiguous-looking "control returned to player."

Tiers live in `ACTIVITY_MAP` ([packages/client-ink/src/tui/activity.ts](../packages/client-ink/src/tui/activity.ts)). Example progression for `starting_session`:

| Elapsed | Label |
|---|---|
| 0–14s | `Preparing your campaign...` |
| 15–44s | `Setting the scene...` |
| 45s+ | `Almost there...` |

The timestamp is set client-side: `engineStateSince` is stamped whenever `engineState` transitions to a new value (`event-handler.ts`), and the `session:transition` handler also sets it so the elapsed counter spans the WS reconnect.


## Usage Gauge

A 5-cell gem-themed provider-usage indicator rendered in the bottom-right corner of the Conversation Pane (last row, right-aligned). It shares that row with the narrative scroll indicator and cannot coexist with it — the gauge appears only when the scroll indicator (`scroll (N) more`) is not shown. The gauge renders nothing when the active provider has no usage concept (no `primary` segment in its `UsageStatus`).

The gauge represents remaining capacity as a unary countdown of 25 ticks (4% per tick across the 0–100% remaining range, rounded to the nearest tick). The five cells each hold 5 ticks; the leftmost cell depletes first. Each cell passes through visual states as it drains:

| State | Glyph | Color | Ticks in cell |
|---|---|---|---|
| Full | `◆` | Light blue (`#529EAB`) | 5 |
| Topaz | `■` | Yellow-gold (`#A88912`) | 4 |
| Ruby | `⬢` | Red (`#781313`) | 3 |
| Tarnished | `*` | Grey | 1–2 (collapsed) |
| Empty | (space) | — | 0 |

The middle two states are ordered by perceived brightness rather than gemstone value: the warm topaz reads as "more remaining" to the eye than the dark ruby, so it sits higher in the drain.

Because ticks 1 and 2 within a cell both render as `*`, the bottom 8% of each cell's drain is visually compressed into one state; the gauge still updates on every 4% step. The `primary` segment must be a `percentage` segment carrying a `usedPercent` — currently only the openai-chatgpt provider supplies one (its 5-hour rate-limit window); see [openai-chatgpt-provider.md](openai-chatgpt-provider.md) for the server-side `subscribeUsage` implementation.

**Code:** `packages/client-ink/src/tui/components/UsageGauge.tsx` (`gaugeCells`), rendered in `NarrativeArea.tsx`.


## DM Text Formatting

The DM can use a small set of inline tags in narration for dramatic effect. These are processed through a single AST-based pipeline (`processNarrativeLines`) and rendered as Ink components.

Available tags:
- `<b>`, `<i>`, `<u>` — bold, italic, underline
- `<code>` — inline monospace (rendered dim), for diegetic system text / identifiers
- `<sub>`, `<sup>` — subscript, superscript (rendered via Unicode substitution in `render-nodes.tsx`; chars without a Unicode equivalent pass through unchanged)
- `<center>`, `<right>` — text justification (default is left); the content **wraps** to terminal width
- `<quote>` — a block-level set-apart passage (letter, inscription, readout): split onto its own line and rendered as an indented block with a left rule (`▏`), content wrapped to width minus the rule. Multi-line via `<br>`. Deliberately **not** Markdown `>` (which collides with the player display-log marker).
- `<br>` — a hard line break, a contentless `linebreak` leaf; inside an alignment or quote block it splits a multi-line sign into independent rows
- `<color=#hex>` — hex color (e.g., `<color=#cc0000>The King has died.</color>`)

The DM contract (`packages/engine/src/prompts/dm-directives.md`, `<formatting>` block) teaches this set. The tag vocabulary is defined once by the `FormattingTag` union in `packages/shared/src/types/tui.ts`.

**Markdown lists** are a tolerated block construct (not a tag): a line beginning `- `/`* ` or `N.`/`N)` becomes a `kind: "list"` row with a resolved marker (`•` or the literal number) and a hanging indent, content wrapped to width minus the indent. Consecutive items render tight (the `appendDelta` spacer between them is collapsed); nesting is intentionally flattened. Markers/indent are renderer-side decoration carried on `ProcessedLine.listMarker`/`listIndent`.

Anything tag-shaped but outside the vocabulary is **stripped to its content** — it never renders as literal markup (the no-leak guarantee). Dialect synonyms (`<strong>`→`<b>`, `<em>`→`<i>`, `<h1-6>`→bold, `<blockquote>`→`<quote>`, attribute variants, a little inline Markdown) are mapped onto the canonical set first, by `narrative/normalize.ts`. A bare `<` that isn't a tag (`3 < 5`, `<3`) stays literal. None of this changes game state.

### Formatting Pipeline

All DM text processing flows through `processNarrativeLines(lines, width, quoteColor?) → ProcessedLine[]`:

1. **Normalize** each DM line's dialect into the canonical vocabulary (`narrative/normalize.ts`) before anything else, then **tighten lists** (drop the `appendDelta` spacer between adjacent list items)
2. **Heal** cross-line tags on raw strings (all formatting tags persist across source lines; only real paragraph boundaries — blank DM lines from `\n\n` — reset the tag stack; visual spacers from single `\n` don't reset; `<br>` is a leaf and does **not** reset the stack). List items are detected here, healed self-contained (marker lifted to metadata), and reset the heal stack.
3. **Parse** healed text into `FormattingNode[]` AST via `parseFormatting`
4. **Layout** each line into width-safe physical rows by DISPLAY width via `narrative/layout.ts` (`layoutRuns`): wraps by terminal columns using the real `string-width`, hard-breaks an overlong token, splits a run on `<br>`, and wraps aligned/quote blocks (each to width minus its rule/indent) and list items (to width minus the hanging indent). Tags never break across rows. (The legacy `wrapNodes` measures code units and is retained only for the modals.)
5. **Frame** block groups (`<center>`, `<right>`, `<quote>`) with blank lines for breathing room (consecutive rows of one block are not split)
6. **Quote highlight** with paragraph-scoped reset (blank DM lines reset quote state)

Non-DM lines (player, dev, system) pass through without entering the formatting pipeline.

The contract is pinned by an invariant harness (`narrative/harness/`) that runs the real pipeline over synthetic fixtures, a seeded generator of legal documents, and the committed/live campaign corpus, asserting no-leak, width-safety (real display width), content preservation, well-formedness, alignment, and cache-transparent determinism at every width. See [e2e-harness.md](e2e-harness.md).

### Quote Highlighting

The narrative area automatically detects quoted dialogue (`"..."`) and applies color highlighting (default: bright white). This makes NPC speech visually distinct without the DM needing to use `<color>` tags. Quote state is tracked across line boundaries so multi-line dialogue renders correctly. Quote state resets at paragraph boundaries (blank DM lines) to prevent an unbalanced quote from inverting all subsequent highlighting.


## Theme System

Themes control the visual frame art and colors of the Conversation Pane. A theme pairs a human-editable `.theme` asset file (defining the ASCII/Unicode art) with an OKLCH-generated color swatch (defining the palette). The Player Pane uses a simple `SimpleBorder` and is not affected by the theme.

### Theme asset format

Theme assets are `.theme` files stored in `src/tui/themes/assets/`. The format is INI-like with `@metadata` lines and `[section]` headers containing literal ASCII art rows:

```ini
@name gothic
@height: 2

[corner_tl]
╔═
║

[edge_top]
══
══

[corner_tr]
═╗
 ║

[edge_left]
║
║

[edge_right]
║
║

[edge_bottom]
══

[corner_bl]
╚═

[corner_br]
═╝

[separator_left_top]
╠═

[separator_right_top]
═╣

[separator_left_bottom]
╠═

[separator_right_bottom]
═╣

[turn_separator]
───── † ─────
```

The parser (`parseThemeAsset()`) validates that all 13 required components are present: `corner_tl`, `corner_tr`, `corner_bl`, `corner_br`, `edge_top`, `edge_bottom`, `edge_left`, `edge_right`, `separator_left_top`, `separator_right_top`, `separator_left_bottom`, `separator_right_bottom`, `turn_separator`.

The composition engine (`composeTopFrame`, `composeBottomFrame`, `composeSideColumn`, etc.) assembles these components into full-width frame rows, filling horizontal edges to the available width and repeating vertical edges to the available height.

### OKLCH color system

Colors are generated at runtime from an OKLCH arc generator (`src/tui/color/`). A **swatch** is an array of hex color strings produced by walking a parametric curve through OKLCH color space:

- **Hue arc**: start hue → end hue (degrees), direction (cw/ccw/shortest)
- **Chroma curve**: composable `CurveFunction` (t ∈ [0,1] → value) mapped to a min/max range
- **Lightness curve**: same, mapped to a min/max lightness range
- **Steps**: number of colors to generate (typically 8–10)

Curve primitives (`src/tui/color/curves.ts`): `constant`, `linearRamp`, `sinePulse`, `easeInOut`, `bell`, `compose`. Presets combine these to define genre-specific palette shapes.

Built-in swatch presets: `foliage`, `cyberpunk`, `ember`, `ethereal`. Each preset defines a `PresetFactory` that builds `SwatchParams` from a base hex color.

#### Harmony swatches

A single arc produces one row of colors (anchor 0). A **harmony swatch** extends this to multiple rows by generating parallel arcs centered on different hue anchors derived from color theory:

| Harmony type | Anchors | Hue offsets |
|---|---|---|
| `analogous` | 3 | 0°, −30°, +30° |
| `complementary` | 2 | 0°, 180° |
| `split-complementary` | 3 | 0°, 150°, 210° |
| `triadic` | 3 | 0°, 120°, 240° |
| `tetradic` | 4 | 0°, 90°, 180°, 270° |

Row 0 is always the key color arc. Each subsequent row uses the same preset but centered on a different harmony anchor hue.

**Code:** `generateHarmonySwatch(preset, keyColor, harmony)` in `src/tui/color/swatch.ts`

#### Color map encoding

A `ThemeColorMap` assigns encoded swatch indices to frame parts. Values encode a position in the 2D harmony swatch grid:

- **0–99**: index into anchor 0 (key color arc). `value` = step.
- **≥ 100**: `anchor = floor(value / 100)`, `step = value % 100`. E.g., `102` = anchor 1 step 2.

| Color map key | Applied to |
|---|---|
| `border` | Top/bottom frame edges |
| `corner` | Corner decorations |
| `title` | Resource display text, turn indicator text |
| `sideFrame` | Left/right side columns |
| `separator` | Activity line separator, turn separator flourish |
| `turnIndicator` | Turn indicator text |

### Variants

The campaign genre sets a default theme during game init. Each theme has **variants** that override swatch parameters and/or color map entries:

| Variant | When active |
|---|---|
| `exploration` | Default — out of combat, general play |
| `combat` | During initiative (between `start_combat` and `end_combat`) |
| `ooc` | During OOC mode |
| `levelup` | During character advancement subagent |
| `dev` | During dev mode (developer console) |

The DM switches variants via `style_scene` tool calls, or the engine switches automatically on mode changes (combat start, OOC entry, etc.).

### Theme resolution

A `ThemeDefinition` specifies the theme asset name, base swatch configuration, and per-variant overrides. `resolveTheme(definition, variant, keyColor?)` produces a `ResolvedTheme` containing:
- The parsed `ThemeAsset` (art components)
- A generated `swatch` (anchor 0 arc) and `harmonySwatch` (full 2D grid) for the active variant
- A `ThemeColorMap` mapping frame parts to swatch colors
- The `keyColor` and `variant` used to generate it

An optional `keyColor` (hex) shifts the swatch hue to center on that color, allowing location-specific tinting without changing the theme art.

### Built-in themes

35 themes ship in `assets/`, grouped by the underlying ASCII frame family:

| Frame family | Themes | Height | Feel |
|---|---|---|---|
| `clean` | `clean` | 1 | Minimal borders |
| `terminal` | `terminal`, `cold_steel`, `bio_lab`, `klaxon`, `neon_grid`, `soft_machine` | 1 | Single-line ASCII / circuit boards |
| `noir` | `whiskey_neon`, `cold_open`, `wet_pavement` | 1 | Thin cinematic single-line |
| `arcane` | `arcane` | 2 | Ornate Unicode flourishes |
| `gothic` | `gothic` | 2 | Double-line box-drawing, muted |
| `scriptorium` | `scriptorium`, `palimpsest`, `bonfire_letter`, `field_notes`, `glitched_margin` | 2 | Illuminated manuscript / loose-leaf |
| `tendrils` | `forest_fey`, `bloom_horror`, `wild_growth`, `congregation` | 2 | Vines, fey woods, choking growth |
| `rune` | `old_oaths`, `salt_throne`, `elder_stone` | 2 | Runestone, angular, weighty |
| `bone` | `mortuary`, `wraithlight`, `inner_dark` | 2 | Skeletal, broken, dust |
| `starlight` | `void`, `nebula`, `signal_noise` | 2 | Sparse star drift, deep space |
| `brass` | `clockwork`, `corporate_dread` | 2 | Brass plate, gears, ledger |
| `woven` | `hearth`, `autumn_market`, `sunday_morning` | 2 | Basket weave, quilt, slice-of-life |

Each theme declares its own `@genre_tags` and may override `[colors]`, `[variant_combat]`, `[variant_ooc]`, etc. for mood. Run `node --import tsx/esm tools/theme-editor/scripts/validate.mjs` after editing to confirm a theme still parses and resolves all variants.

### Location-scoped themes

The DM can persist a theme + key color to a location entity's front matter via the `style_scene` tool with `save_to_location: true`. On scene transition to that location, the theme auto-applies. Front matter fields:

```
**Theme:** gothic
**Key Color:** #8844aa
```

This creates atmospheric consistency — a haunted crypt always feels dark purple, a sunlit market always feels warm gold — without the DM needing to manually switch themes on every scene transition.


## Responsive Design

The TUI targets **80×25 minimum**, with **80×40 for the full experience**. Two tiers handle the difference.

### Breakpoints

| Tier | Requirement | Layout |
|---|---|---|
| **Full** | ≥80 cols, ≥40 rows | All elements visible. Side frames, top frame, activity line, lower frame. |
| **Standard** | Everything else | Top frame and activity line dropped. Activity glyph moves to modeline. |

Below 80×25, the game replaces the entire UI with a fullscreen `TerminalTooSmall` blocker showing the current dimensions, the minimum required (80×25), and "Resize your terminal to continue." The blocker clears automatically when the terminal is resized above the minimum.

**Code:** `src/tui/components/TerminalTooSmall.tsx`, checked in `src/phases/PlayingPhase.tsx`

### Drop order (full → standard)

1. **Top frame** (resource display) — resources still available via character sheet
2. **Activity line** — degrades to single glyph in modeline


## Modals

The app is not productivity software — immersion matters. Modals use the same theme system as the main TUI, appearing as themed bordered windows over the narrative area. They feel like part of the game world, not like dialogs.

### Character Sheet

Triggered by the player (hotkey) or the DM (tool call). Renders the active character's sheet as a styled modal. Read-only during gameplay — edits happen through game mechanics or OOC.

### Player Choices

A core UX element. The DM (or the engine) presents the player with structured options at decision points. The player picks from the list or types freeform.

```
The passage forks ahead.
▲    ◆ Enter your own...
▼  > ◆ Left — you hear running water
     ◆ Right — a draft smells of smoke
     ◆ Listen carefully first

                            ESC dismiss
```

Choices reach the player two independent ways:

Engine-suggested (background): after a DM turn, *if the DM did not present choices itself*, the engine may auto-generate 2-3 options via the `choice-generator` subagent and deliver them as a synthetic `present_choices` command (`maybeGenerateSuggestedChoices`). Gated by the campaign's Choices Frequency setting (`never`/`rarely`/`sometimes`/`often`/`always`) with optional per-player overrides. Cheap, fast, doesn't need to be brilliant — freeform is always available. When fewer than 5 options are shown, focus defaults to "Enter your own" so the player can freely type and press Enter without navigating.

DM-authored (the `present_choices` tool): the DM sets specific options when it matters narratively, passing `prompt` and `choices`. Optional `descriptions` provide per-choice detail shown in a fixed-height region (3 rows) that updates as the player highlights each option. Note the DM's tool does **not** auto-generate: calling it with no `choices` shows an all-but-empty modal *and* sets `dmProvidedChoicesThisTurn`, which suppresses the engine-suggested path above for that turn. So the DM authors real options or leaves the tool alone and lets the background path offer them.

```
present_choices({
  prompt: "The creature extends a hand. Its eyes are ancient.",
  choices: [
    "◆ Take its hand",
    "◆ Refuse",
    "◆ Ask its name first"
  ],
  descriptions: [
    "Trust this being and accept whatever bond it offers.",
    "Step back. You owe this creature nothing.",
    "Buy time. Learn what you're dealing with before committing."
  ]
})
```

**Formatting:** Choice labels and descriptions support the same inline formatting tags as DM narration (`<b>`, `<i>`, `<u>`, `<color=#hex>`). Labels are word-wrapped via `wrapNodes` when they exceed the available width — the scroll window operates on visual rows so wrapped items simply consume more of the 5-row budget. All three choice-producing agents (DM, setup conversation, choice generator) prepend a Unicode bullet glyph to each label; `stripLeadingBullet()` removes it before the selection is sent back as a player action. Descriptions are parsed through `parseFormatting` and rendered with `renderNodes`.

**Layout:** Choices render inside the Player Pane as a `ChoiceOverlay`. The prefix for each choice row is 4 characters: `[arrow][gap][cursor][space]`. Scroll indicators (▲/▼) occupy the first column at rows 0–1 of the choice region, always visible (bright `#aaff00` when scrollable, dimmed when not). The selection cursor (>) occupies the third column, colored with the active player's theme color (falling back to the theme's key color during setup). The two columns never interfere.

**Player Pane expansion:** When descriptions are present, the Player Pane expands by `DESCRIPTION_ROWS` (3) to accommodate the description region above the choice list. The Conversation Pane shrinks to compensate. Without descriptions, the standard 7-row Player Pane layout is used.

**Code:** `src/tui/modals/ChoiceModal.tsx` (`ChoiceOverlay`, `DESCRIPTION_ROWS`), `src/tui/layout.tsx` (`playerPaneExtraHeight`), `src/tui/formatting.ts` (`stripLeadingBullet`)

The player's selection (or freeform text) is returned to the DM as the player's action, tagged normally: `[Aldric] Take its hand`.

**Frequency configuration:**

Set at campaign level during init, with a player-level override:

| Setting | Behavior |
|---|---|
| `none` | Choices never auto-generated. DM can still explicitly call `present_choices`. |
| `rarely` | Auto-generated only at major decision points (scene-level choices). |
| `often` | Auto-generated at most decision points after DM narration. |
| `always` | Auto-generated after every DM narration that expects player input. |

```jsonc
// config.json (partial)
{
  "choices": {
    "campaign_default": "often",
    "player_overrides": {
      "alex": "always",    // new player, wants guidance
      "jordan": "rarely"   // experienced, prefers freeform
    }
  }
}
```

When auto-generation is active, the engine detects "it's the player's turn" and fires a Haiku subagent with the last few exchanges to generate options. If the DM also explicitly called `present_choices` on that turn, the explicit choices take precedence.

### Compendium Browser

Player-accessible via ESC menu → Compendium. Displays a navigable tree of everything the player has learned. The category list is the `COMPENDIUM_CATEGORIES` constant in `packages/shared/src/types/compendium.ts` (currently: Characters, Places, Items, Storyline, Lore, Objectives).

**Navigation**: Up/Down arrows move cursor in the tree, Enter on a category expands/collapses, Enter on an entry shows detail view, ESC in the tree closes the modal.

**Detail view**: Shows entry summary, aliases, scene range, and related entries.

**Wikilink navigation**: Tab / Shift+Tab cycle through `[[wikilinks]]` in the entry text — the cursored link renders inverse; links whose slug doesn't resolve render red (Wikipedia-style "dead link"). Enter follows the cursored link and pushes the current entry onto a back-stack. Backspace pops the stack — back to a previous entry, or back to the tree when empty. ESC always closes the modal.

**Data source**: `campaign/compendium.json`, maintained by a Haiku subagent at scene transitions. Player-facing only — no DM secrets.

**Code:** `packages/client-ink/src/tui/modals/CompendiumModal.tsx`

### Session Recap

On `session_resume`, the "Previously on..." summary displays as a modal before gameplay begins. Sets the mood and reminds the player where they left off.

### Game Menu

ESC key opens the game menu modal. Items are organized into colour-tinted groups (View / Session / Settings / Exit) so the cursor doesn't land on a leave action when the user opens the menu to do something:

```
╔══════════════════════════════╗
║   ── View ──                 ║
║     ◆ Character Sheet        ║
║     ○ Compendium             ║
║     ○ Player Notes           ║
║   ── Session ──              ║
║     ○ Engine Console         ║   ← only when Dev Mode is enabled
║     ○ Save Transcript        ║
║   ── Settings ──             ║
║     ○ Campaign Settings      ║
║   ── Exit ──                 ║
║     ○ Resume                 ║
║     ○ Return to Menu         ║
╚══════════════════════════════╝
```

Standard navigation (arrow keys + Enter). "Resume" dismisses the menu. "Return to Menu" persists state and returns to the main menu (the engine's session save runs as part of teardown). OOC Mode is no longer a menu entry — the DM detects out-of-character intent automatically. End Session was removed for the same reason: the campaign ends when the player returns to the menu, not via an explicit kill switch. Engine Console is the developer view of the running session; it's gated on the Dev Mode toggle in Campaign Settings.

### Campaign Settings

Player-accessible via ESC menu → Settings → Campaign Settings. The modal shows campaign identity fields (read-only: name, system, genre, mood, difficulty, scope) and three editable per-campaign settings. Rows are organized into colour-tinted groups — **About** (identity), **Preferences** (the editable settings), **Recovery** (Roll Back Game) — mirroring the ESC menu's group-header pattern, with the focused row's label tinted and bold.

| Row | Setting | Controls | Persists to |
|---|---|---|---|
| **Choices Frequency** | How often the DM offers suggested responses | ←/→ cycle through Never / Rarely / Sometimes / Often / Always | `config.json` `choices.campaign_default` |
| **DM Turn Length** | Page-size multiplier reported to the DM each turn. Lower = tighter prose; 100% = actual terminal size. | ←/→ adjust in 5% steps (range 50–150%, default 80%) | `config.json` `dm_turn_length_pct` |
| **Image Generation** | Whether the DM can illustrate moments inline. Takes effect from the next DM turn; requires a provider/model with image-generation capability. | ←/→ (either arrow toggles On/Off) | `config.json` `image_generation` |

A final row, **Roll Back Game**, is an action rather than a setting: Enter opens a savepoint picker (`RollbackPickerModal`, fed by `GET /session/savepoints`) → confirmation (`RollbackConfirmModal`) → the `/rollback` command with the chosen commit oid. See [error-recovery.md](error-recovery.md#rollback) for the full rollback flow (incl. the pre-rollback backup).

**Navigation:** ↑/↓ move between rows; ←/→ adjust the focused row. Enter commits all dirty changes and returns to the Game Menu. ESC cancels any unsaved changes and returns to the Game Menu. Changes round-trip to the engine via `PATCH /session/settings` and persist to `config.json`.

**Code:** `packages/client-ink/src/tui/modals/CampaignSettingsModal.tsx`, wired in `packages/client-ink/src/phases/PlayingPhase.tsx` (callbacks `onChoicesFrequencyChange`, `onDmTurnLengthPctChange`, `onImageGenerationChange`). The bounds constants `DM_TURN_LENGTH_PCT_MIN` (50), `DM_TURN_LENGTH_PCT_MAX` (150), `DM_TURN_LENGTH_PCT_DEFAULT` (80), and `DM_TURN_LENGTH_PCT_STEP` (5) are exported from `packages/shared/src/types/config.ts`.

### Player Notes

Player-accessible via ESC menu → Player Notes. Opens a simple multi-line plain-text editor. Saves on ESC close. Persisted to `campaign/player-notes.md`.

The editor handles arrow navigation, home/end (Ctrl+A/E), horizontal scroll for long lines, and vertical scroll within the modal. Uses CenteredModal's `rawRows` mode for custom cursor rendering (inverse video) while reusing the shared modal frame.

**Code:** `src/tui/modals/PlayerNotesModal.tsx`

### Color Swatch Modal

The `/swatch` command opens a debug modal showing the full harmony swatch grid, column step indices, row anchor labels (0, 100, 200, ...), and current `colorMap` assignments. Useful for tuning color maps and verifying swatch generation. Dismissed with any key.

**Code:** `src/tui/modals/SwatchModal.tsx`

### API Error Modal

Shown center-screen during API retry backoff. Rendered by `PlayingPhase` whenever a retry overlay is active for the current attempt (`apiErrorModalActive && retryOverlay`).

The modal owns its own countdown timer: a `setInterval` that ticks once per second, decrementing from `overlay.delaySec` down to 0. The timer resets whenever `overlay.status`, `overlay.delaySec`, or `overlay.attemptId` changes — so successive retries with identical backoff durations (the backoff caps at 12s) still reset the visible countdown rather than freezing at 0.

**Body content** (from `ApiErrorModal.tsx`):
- A human-friendly error-kind label via `retryLabel(overlay.status)` — `Connection lost` (status 0), `Rate limited` (429), `API overloaded` (529), or `API error (N)` for any other status.
- `Retrying in Ns...` — the live countdown.
- `Will auto-resume on reconnect.`

**Title:** `Connection Error`. **Footer:** `Esc to dismiss`.

**Dismiss behavior:** Esc sets a `dismissedAttemptId` latch equal to the current `overlay.attemptId`. The modal hides for that attempt but reappears automatically when the next retry fires (each retry bumps `attemptId`). When the parent clears the retry overlay on a successful retry, the modal auto-dismisses and the latch resets to `null`. Retries continue in the background whether or not the modal is visible.

**Code:** `packages/client-ink/src/tui/modals/ApiErrorModal.tsx`, wired in `packages/client-ink/src/phases/PlayingPhase.tsx`. For the retry backoff schedule and error-kind labels, see [error-recovery.md — API Failures](error-recovery.md#api-failures).

### Archiving a campaign

Triggered from the main menu's campaign sub-list by pressing Enter on the Archive column. Unlike resume (which collapses the list) the sub-list **stays expanded**: the triggered row swaps its `Archive`/`Delete` buttons for an inline `Archiving…` label, and the entry drops out of the list on its own when the archive completes and the parent refreshes `campaigns`.

While an archive is in flight, **all actions on that entry are blocked** (resume, re-archive, delete) — the archive deletes the campaign's source folder on success, so acting on it mid-flight would race. This guard is two-layered: the client ignores repeat triggers for an in-flight id (`archivingIds` prop, threaded from `app.tsx`), and the server rejects a concurrent `POST /manage/campaigns/:id/archive` for the same campaign with **409 Conflict** ("Archive already in progress"). The server guard is the authoritative one — two overlapping archives compute the same destination zip path and race each other's source deletion, corrupting the archive ("contents mismatch on disk"). A double-fire from an unguarded UI was the original trigger.

**Code:** `onArchiveCampaign` / `archivingIds` in `packages/client-ink/src/app.tsx` and `packages/client-ink/src/phases/MainMenuPhase.tsx`; the `archivesInProgress` lock in `packages/engine/src/server/routes/management.ts`.

**Restore (the symmetric twin).** Restoring an archive from the Archived Campaigns list (Enter on an entry, ArchivedCampaignsPhase) carries the same two-layer guard, keyed by **zip path** instead of campaign id. The selected row shows an inline `Restoring…` and ignores repeat Enter while in flight (`restoringPaths` prop from `app.tsx`); the server rejects a concurrent `POST /manage/campaigns/archived/:name/restore` for the same zip with **409 Conflict** ("Restore already in progress"), via the `restoresInProgress` lock. Restore is actually the *more* double-fire-prone of the two — the screen doesn't move on Enter — and a duplicate restore races the unique-slot loop (TOCTOU between the `exists` check and `mkdir`), colliding on one dir or spawning duplicate `-2`/`-3` slots. Restore is non-destructive (it never deletes the archive or an existing campaign), so the stakes are lower than archive, but the guard keeps the behavior clean.

The restore route resolves its target **strictly inside `archiveDir()`** (the canonical `archivedcampaigns/` dir — a *sibling* of the campaigns dir, not a child): the client echoes back a `zipPath` from the list endpoint, but the server trusts only its filename component, so a crafted body or `:name` can't traverse out (`..`) or turn the endpoint into an arbitrary-zip reader. A target whose basename isn't a `.zip` is rejected with **400**.

### Delete Campaign Modal

A confirmation modal shown over the full-screen main-menu frame before a campaign is permanently removed. Triggered from the main menu's campaign sub-list when the player presses Enter on the Delete column.

The modal displays three pieces of identifying information sourced from `getCampaignDeleteInfo()` (`packages/engine/src/config/campaign-archive.ts`):
- Campaign name
- Character names (comma-separated; `(none)` if the roster is empty)
- Approximate DM turn count (`~N turn`/`turns`)

A warning line reads "This cannot be undone." beneath the summary.

**Navigation:** Left/Right arrows toggle between the `[Delete]` and `[Cancel]` buttons; Enter confirms the focused button; ESC always cancels. The selection **defaults to Cancel** to prevent accidental deletion — Delete must be explicitly focused before Enter commits.

**Code:** `packages/client-ink/src/tui/modals/DeleteCampaignModal.tsx`, wired in `packages/client-ink/src/phases/MainMenuPhase.tsx` (`deleteModal` prop / `onConfirmDelete` / `onCancelDelete`).

### Modal behavior

- Modals overlay the narrative area, not the full screen. The modeline and player selector remain visible underneath.
- Modals inherit the active theme variant (a combat choice modal uses the combat theme variant).
- **Modal colors are derived from the main theme** — `deriveModalTheme()` shifts all colorMap values to anchor 1 (complementary hue, 180° away) and mirrors step indices (inverted lightness). This makes modals visually distinct from the game frame without requiring separate color configuration.
- Modals are dismissed with ESC (back to game), Enter (confirm selection), or the relevant hotkey.
- When modal content exceeds available height, it scrolls with a scroll indicator (e.g. `scroll (5) more`) and supports PageUp/PageDown navigation.
- At minimal viewport sizes, modals take the full screen.

**Code:** `deriveModalTheme()` in `src/tui/themes/color-resolve.ts`, applied automatically in `CenteredModal` and `Modal`.

### CenteredModal content modes

`CenteredModal` is the base component for themed, scrollable, centered modals. It supports four content modes (listed by precedence):

| Mode | Prop | Use case |
|---|---|---|
| **rawRows** | `rawRows: ReactNode[]` | Pre-rendered row nodes for custom rendering (e.g. cursor, highlighting). Caller pads each row to `innerWidth`; CenteredModal adds side padding. |
| **children** | `children: ReactNode` | Arbitrary React content (e.g. SwatchModal's color grid). Requires explicit `contentHeight`. |
| **styledLines** | `styledLines: FormattingNode[][]` | Pre-parsed formatting nodes (e.g. CompendiumModal's tree). Word-wrapped automatically. |
| **lines** | `lines: string[]` | Plain text. Word-wrapped automatically. |

**Self-handling keyboard input:** Read-only modals set `scrollKeys={true}` and pass an `onDismiss` callback. CenteredModal handles PageUp/PageDown/arrows/+/- for scrolling and ESC/Enter for dismissal internally. Modals with custom input (CompendiumModal, PlayerNotesModal) leave `scrollKeys` off and manage their own `useInput`.

### FullScreenFrame

`FullScreenFrame` is the shared layout shell for out-of-game full-screen pages (MainMenuPhase, SettingsPhase). It renders the themed top/bottom borders, side frames, and vertically centers children within the content area. Callers pass `contentRows` (the number of rows their content occupies) for centering math.

The main menu uses `FullScreenFrame` with `starfield` enabled — the padding area renders an animated starfield (`Starfield.tsx`) seeded with the current time, so the visual differs between sessions without producing motion that competes with the menu cursor.

**Code:** `packages/client-ink/src/tui/components/FullScreenFrame.tsx`, `packages/client-ink/src/tui/components/Starfield.tsx`


## Character Pane

The character pane is a right-side overlay (Tab toggle) that shows the active character's stats and inventory inside the narrative area. It uses `OverlayPane` — a reusable right-aligned overlay component with themed borders in the complementary (modal) color scheme.

**Behavior:**
- Toggled with Tab (or via key hints indicator in the Player Pane top-right)
- Tab stays available while a choice overlay is on screen — the quick view opens over the narrative and the overlay keeps arrow/Enter for selection, so the two don't conflict (the Tab toggle is handled ahead of the choices input guard)
- 35-column fixed-width panel, right-aligned over the narrative area
- Lazy-fetches the character sheet on first open via `GET /session/character/:name` (returns `{ name, content }`)
- Caches content across toggles; cache invalidates when the active player changes
- Extracts "Stats" and "Inventory" sections from the character's markdown sheet
- Shows a loading placeholder while fetching, error message on failure, "no stats found" if sections are empty

**OverlayPane** is the base component: themed multi-line borders, word-wrapping, scrolling with scroll indicator, and opacity (paints over narrative text with spaces for full coverage).

**Code:** `packages/client-ink/src/tui/modals/CharacterPane.tsx`, `packages/client-ink/src/tui/modals/OverlayPane.tsx`


## Character Sheet Colorization

`colorizeSheetLines()` is the shared entry point for theme-aware auto-colorization of entity markdown content. It is called by CharacterSheetModal, CharacterPane, and the CompendiumModal detail view. The function accepts an array of source lines and a `ColorizeOptions` object and returns `FormattingNode[][]` ready for rendering. The underlying entity markdown is the source of truth and is never mutated — all coloring is render-time only.

**Colorization rules** (applied per line, structural patterns detected before the standard markdown→tag conversion so colored wrappers sit *outside* any bold):

1. **Headings** (`#`…`######`): the whole line is wrapped in the heading color (complement-anchor step 3) plus bold, bypassing `markdownToTags`.
2. **Front-matter / KV lines** (`**Key:** Value`, also `- **Key:** Value`): the bold key span is colored with the key-label color (complement-anchor step 4); the value runs through `markdownToTags` so inline markdown in values still renders.
3. **Wikilinks** (`[[Name]]`): transformed before `markdownToTags`, with the display name colored in the entity hue. Two modes:
   - `"preserve"` — emits a render-only `<wikilink slug=…>` AST tag that retains the slug for Tab-cycle navigation (CharacterSheetModal, CompendiumModal).
   - `"strip"` — removes the brackets and renders the bare name (CharacterPane, which has no navigation).
4. **Bare hex strings** (`#rrggbb`): auto-wrapped as `<color=#rrggbb>#rrggbb</color>`. A negative lookbehind prevents re-wrapping a hex string already inside a `<color=…>` attribute.

**Entity hue resolution** — `pickEntityHue()` checks the entity front matter for `color`, then `key_color`, then `theme_color`; if none is a valid hex it falls back to `theme.keyColor`. This hue colors wikilinks so cross-references read in the entity's "own" color.

**`frameAnchor` parameter** controls which harmony-swatch arc the heading/key-label accents are pulled from: the accent arc is the *complement* of the surrounding frame's anchor, so accents visually offset the frame.
- `frameAnchor: 0` — CharacterPane (its frame uses anchor 0 directly); accents come from anchor 1.
- `frameAnchor: 1` — CharacterSheetModal and CompendiumModal (their `CenteredModal` wrapper applies `deriveModalTheme()`, i.e. anchor 1); accents swing back to anchor 0.

Authored formatting tags (`<b>`, `<color=#…>`, etc.) in the source pass through unchanged, so Scribe / Compendium-updater emphasis doesn't collide with the auto-coloring rules.

**Code:** `packages/client-ink/src/tui/character-colorization.ts`


## Keyboard Input

### Kitty Keyboard Protocol

On terminals that support it, Machine Violet enables the [Kitty keyboard protocol](https://sw.re/kitty/keyboard-protocol/) for unambiguous key identification. This eliminates key corruption on Windows ConPTY, where Backspace, Home, and End are misidentified under legacy escape sequences.

**Detection:** On startup, the TUI probes the terminal with a Kitty `QUERY` escape (`\x1b[?u`). If the terminal responds, Kitty mode is enabled by pushing the disambiguation flag. Detection runs with a timeout — unsupported terminals simply don't respond and the probe is silently abandoned.

**Runtime:** When enabled, every keypress arrives as a CSI-u escape sequence. A stdin filter intercepts these before Ink sees them, parses them via `parseKittyKey()`, and re-emits legacy byte sequences via `kittyKeyToLegacy()` that Ink's input system understands. This is transparent to all other TUI code.

**Cleanup:** Protocol flags are popped on exit, including the explicit SIGINT path and normal teardown/exit handling, to restore the terminal to its original state.

**Code:** `packages/client-ink/src/tui/hooks/kittyProtocol.ts`

### Stdin Filter Chain

Multiple input preprocessors (Kitty protocol, mouse scroll) need to intercept raw stdin data before Ink processes it. The **stdin filter chain** (`installStdinFilterChain`) wraps `stdin.read()` once and runs registered filters in order. Each filter processes its sequences, strips matched bytes, and returns the remainder. This avoids fragile monkey-patching of stdin by multiple independent handlers.

**Code:** `packages/client-ink/src/tui/hooks/stdinFilterChain.ts`

### Mouse Scroll

On TTY terminals, Machine Violet enables SGR mouse reporting so the mouse wheel scrolls the narrative area.

**Protocol:** Two ANSI escapes are written to `stdout` on mount: `\x1b[?1000h` (basic button-event tracking, includes scroll wheel) and `\x1b[?1006h` (SGR extended encoding — clean ASCII, no 223-column limit). The matching `l` sequences are written on unmount to restore the terminal.

**Input interception:** A `mouse` filter is registered on the stdin filter chain. For each stdin chunk the filter scans for SGR mouse sequences matching `\x1b[<btn;x;yM` / `…m`. Sequences where `btn & 64` is set are scroll events; `btn & 1` distinguishes scroll-down (1) from scroll-up (0). Matched sequences are stripped from the chunk before Ink processes it (preventing garbage in the text input). Scroll deltas are dispatched via `process.nextTick` to avoid re-entrant React updates.

**Scroll amount:** each wheel tick scrolls by `LINES_PER_TICK = 2` lines.

**Non-TTY environments:** the hook checks `process.stdout.isTTY` and `process.stdin.isTTY` before enabling mouse mode, so tests and piped I/O are silently skipped.

**Safety net:** a `process.on("exit", …)` listener disables mouse reporting even if the React unmount path doesn't run (e.g. an uncaught exception after the default handler fires), preventing the terminal from being left in mouse mode after a crash.

**Code:** `packages/client-ink/src/tui/hooks/useMouseScroll.ts`

### ConPTY Raw-Mode Watchdog (Windows)

On Windows, ConPTY can silently re-enable `ENABLE_PROCESSED_INPUT` and `ENABLE_LINE_INPUT` during long-running TUI sessions (upstream issue: [microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)). When this happens, Backspace and other control characters are processed destructively by the console host before the application sees them. Calling `setRawMode(true)` again cannot fix it because libuv caches the raw-mode state internally and short-circuits repeated calls when the cached mode matches the requested mode.

Two cooperating mechanisms defend against this:

**`installRawModeGuard`** (called at startup in `start-client.ts`) intercepts `stdin.setRawMode(false)` and swallows it, preventing Ink's reference-counting from ever disabling raw mode. It also exposes `forceRefreshRawMode()`, which toggles raw mode off then on via the *original* (unpatched) `setRawMode`, bypassing both the intercept and libuv's cache. This forces a real `SetConsoleMode` call that restores correct console flags. The cooked-mode window between the two synchronous native calls is a few microseconds.

**`useRawModeGuardian`** (a React hook called in `PlayingPhase`) periodically calls `forceRefreshRawMode()` on a 500 ms interval to recover from any corruption that occurs mid-session. It is a no-op on non-Windows platforms.

The watchdog is enabled only when the Kitty Keyboard Protocol is inactive (`enabled: !hasKittyProtocol`). When Kitty is active, CSI-u encoding is unambiguous regardless of console mode flags, making periodic correction unnecessary.

**Code:** `packages/client-ink/src/tui/hooks/rawModeGuard.ts`, `packages/client-ink/src/tui/hooks/useRawModeGuardian.ts`

### Triple-ESC Emergency Reset

Pressing ESC three times within a 1500 ms window triggers an emergency reset that forcibly clears all overlay and modal state and exits any active mode. It clears the active choices overlay, any active modal, the game menu, and the character pane. If the current mode is `"ooc"` or `"dev"`, it also fires `apiClient.command("exit_mode")` to end the server-side mode session.

This fires before all other ESC handling in the input chain, so it works even when a modal or overlay is blocking normal ESC dismissal (for example, a choice overlay appearing while OOC mode is active, or a modal stuck due to a WebSocket race). It is the only way to recover from certain stuck-overlay states without restarting the client.

**Implementation:** the `escTimestamps` ref (`useRef<number[]>`) in `packages/client-ink/src/phases/PlayingPhase.tsx`; the window filter keeps presses where `now - t <= 1500` and triggers when at least 3 remain.

### InlineTextInput

`InlineTextInput` is the core uncontrolled text-input primitive used by `InputLine` (the player's main entry field) and by the freeform entry slot inside `ChoiceModal`. It is not the same as the PlayerNotes editor, which has its own independent multi-line `editorReducer`.

**Props:**

| Prop | Type | Description |
|---|---|---|
| `defaultValue` | string | Initial text content. Reset by changing the React `key`. |
| `availableWidth` | number | Fixes the rendered column width. Required for horizontal scroll and wrap modes. |
| `placeholder` | string | Dim hint shown when the input is empty; the cursor appears before it. |
| `wrap` | boolean | When true, text wraps to multiple lines instead of scrolling horizontally. Requires `availableWidth`. |
| `maxLines` | number | Cap on visible wrapped lines. When text wraps past this limit, the render window scrolls vertically to keep the cursor line in view. Only applies in wrap mode. |
| `isDisabled` | boolean | Disables all input; renders the raw value without a cursor. |
| `onChange` | function | Fired on every value change (deduplicated). |
| `onCursorOffsetChange` | function | Fired whenever the cursor position changes. Used by ChoiceModal to mirror cursor state for its own wrap-boundary calculations. |
| `onSubmit` | function | Fired on Enter. |

**Overflow modes:**

- **Horizontal scroll (default):** when `availableWidth` is set and `value.length + 1 > availableWidth`, a `viewStart` window tracks the cursor left and right inside the fixed-width viewport. The window snaps left when the cursor moves left of the edge and snaps right when the cursor moves right of the edge. The viewport is always filled — no empty space is left on the right after deletion. Implemented in the exported `computeViewStart` function.
- **Wrap mode (`wrap={true}`):** text wraps at character boundaries at `availableWidth` columns; the cursor line is always visible. With `maxLines`, the vertical window scrolls to keep the cursor in view (tail-anchored: `viewStartLine = max(0, cursorLine - maxLines + 1)`). Used by ChoiceModal's freeform input slot.

**Keybindings:**

| Key | Action |
|---|---|
| Left / Right arrow | Move cursor one character |
| Backspace | Delete character before cursor |
| Delete | Forward-delete character at cursor |
| Ctrl+A | Move cursor to start of text |
| Ctrl+E | Move cursor to end of text |
| Home / End | Move cursor to start / end (raw escape-sequence matching covers xterm, gnome-terminal, rxvt variants) |
| Enter | Submit |

**Bracketed paste:** pasted text arrives via Ink's `usePaste` hook. Embedded newline runs are collapsed to a single space and the result is trimmed, so a trailing-newline paste (`"foo\n"`) lands as `"foo"` without a spurious trailing space. This also prevents pasted `\r` characters from triggering a premature submit.

**Cursor rendering:** an inverse-video block cursor is rendered using chalk. The text is segmented around the cursor position so chalk is called O(1) times regardless of text length.

**Code:** `packages/client-ink/src/tui/components/InlineTextInput.tsx`, `packages/client-ink/src/tui/components/InputLine.tsx`

### KeyHints

`KeyHints` is a small hotkey indicator rendered in the top-right of the Player Pane. It is positioned absolutely (`justifyContent: flex-end`) above the modeline content row and is only rendered when at least one hint is present.

**Data model:** the component accepts a `hints: KeyHint[]` prop, where each `KeyHint` has a `label: string` (display text, e.g. `"Tab"`) and `active: boolean` (whether the associated feature is currently active). The component is a `React.memo` pure renderer.

**Color scheme:** inactive hints render dim gray (`color="gray"` with `dimColor`); active hints render yellow (`color="yellow"`). Hints are separated by a single space.

**Current hints:** the Character Pane toggle state drives the only currently wired hint — a `"Tab"` hint that goes yellow when the Character Pane is open.

**Code:** `packages/client-ink/src/tui/components/KeyHints.tsx`; exported from `packages/client-ink/src/tui/components/index.ts`; rendered in `packages/client-ink/src/tui/layout.tsx`.


## Phase Lifecycle

The app phase state machine: main menu → playing → returning_to_menu → main menu (loop). Setup runs as a pseudo-campaign session inside `PlayingPhase` — there is no separate `SetupPhase` component. The engine sends a `session:transition` event when setup completes and the real campaign session begins, prompting the client to reset state and continue on the existing WebSocket connection.

The main menu also branches to a set of out-of-game full-screen phases — `settings` and the sub-phases it reaches (`api_keys` / ConnectionsPhase, `discord_settings` / DiscordSettingsPhase, `archived_campaigns` / ArchivedCampaignsPhase). These are documented below.

**Code:** `packages/client-ink/src/phases/PlayingPhase.tsx`

### Streaming Render Optimization (`useBatchedNarrativeLines`)

During an active DM turn the engine emits `narrative:delta` WebSocket events at per-token frequency (typically 1–3 characters each). Without batching, every delta would trigger `setNarrativeLines` → a full React/Ink component-tree re-render. To avoid this, narrative line state is managed by the `useBatchedNarrativeLines` hook, which the root `App` component uses as the exclusive source of `narrativeLines`.

**How it works:**

- Functional updaters (the streaming append path) are applied eagerly to a mutable *working ref* (`workingRef`) without touching React state. A `setTimeout` is armed on the first dirty update; when it fires (after `FLUSH_INTERVAL_MS = 16 ms`, ≈ one 60 fps frame), a single immutable snapshot of the working copy is committed to React state.
- Direct (non-functional) sets — used for full replacements such as loading a snapshot or clearing the log — bypass the timer and flush to React state immediately.
- If the component unmounts while a flush is pending, the timer is cleared in a `useEffect` cleanup.

**Effects:** reduces React re-renders by roughly 10–20× during active streaming turns, and reduces GC pressure because only one immutable array is allocated per flush cycle rather than one per token. The `FLUSH_INTERVAL_MS` constant is the default for the optional `flushInterval` parameter, which tests inject to control timing.

**Code:** `packages/client-ink/src/tui/hooks/useBatchedNarrativeLines.ts`

### Settings Screen

Reachable from the main menu via the Settings entry. A full-screen `FullScreenFrame` page (title "Settings") with five navigable items (arrow keys + Enter, ESC to return):

- **API Keys** — navigates to the connections/provider wizard (ConnectionsPhase).
- **Discord** — navigates to Discord Rich Presence opt-in (DiscordSettingsPhase).
- **Archived Campaigns** — navigates to the archived-campaigns list (ArchivedCampaignsPhase).
- **Enable Dev Mode** — on/off toggle. When ON, the Engine Console entry appears in the in-game ESC menu. State persists to `machine-settings.json`.
- **Show Debug Info** — on/off toggle. When ON, internal `dev`-tagged narrative lines (e.g. retry and rollback notices) are visible in the conversation pane. Session-scoped (not persisted to disk).

Toggle items display `ON` (green) or `OFF` (dim) as a suffix. The version string (`vX.Y.Z · released DATE UTC`) is shown in the bottom-left corner.

**Code:** `packages/client-ink/src/phases/SettingsPhase.tsx`

### Connections Screen (ConnectionsPhase)

A full-screen out-of-game wizard (root title: "AI Connections") for managing LLM provider connections and model tier assignments, reached from Settings → API Keys. It uses `FullScreenFrame` for all sub-screens. The root menu has four items selectable with arrow keys + Enter; Escape from any sub-screen returns to the parent.

**Connections list** — shows all configured connections. Each row displays a health indicator (`✔` valid / `⚠` rate-limited / `✘` invalid / `?` unchecked, color-coded), the connection label, provider, and model count. When a live usage snapshot is available (an active session backing that connection — Codex's plan rate-limit windows, or an Anthropic key's request/token rate-limit quota parsed from `anthropic-ratelimit-*` response headers), per-connection usage segments appear indented below the row — each segment shows label, value (percentage, balance, or token count), and a relative reset timer when the segment carries a reset time (Codex windows do; the Anthropic header-derived segments don't). Usage is fetched for all connections on mount and refreshed every 30 seconds. Hotkeys: `R` = recheck health, `D` = delete.

**Model Assignments** — shows the three model tiers (Large: DM narration, Medium: OOC / AI players, Small: mechanical tasks). Each tier displays the currently assigned model and connection label. Enter on a tier enters the model picker, which lists all models from all connections; Enter there assigns the selected model + connection to that tier.

**Add Connection wizard** — a multi-step flow:
1. Provider selection: Anthropic, OpenAI (API key), Custom (OpenAI-compatible, untested). `openai-chatgpt` is intentionally absent — it uses the dedicated "Sign in with ChatGPT" entry. `openrouter` is also absent from the picker: the adapter still exists engine-side, but OpenRouter is hidden pending an end-to-end validation playtest (issue #712) so we don't imply support we can't stand behind. Re-add the row once it's validated.
2. API key entry (text input, Enter to advance).
3. Label entry (optional friendly name, Enter to advance).
4. Base URL entry — only shown for the `custom` provider. Escape backs up one step at each stage.

**Sign in with ChatGPT** — initiates OAuth via the codex app-server (see [openai-chatgpt-provider.md](openai-chatgpt-provider.md) for the server-side flow). The TUI renders a `CenteredModal` overlay over the menu while authentication is in progress. States:
- **Starting**: "Starting Codex subprocess and OAuth flow…" (before the server returns the auth URL).
- **Pending**: shows the auth URL plus the footer `o open in browser · c copy URL · Esc cancel`. `o`/`O` opens the URL via the system browser; `c`/`C` copies it to the clipboard.
- **Success**: "✔ Signed in [as email] [(planType)]." Returns on Enter or Esc; the connections list is refreshed.
- **Cancelled / Error**: status message, returns on Enter or Esc.
- Pressing Escape while pending sends a cancel request to the server before returning.
The login status poll runs every 2 seconds while the chatgpt-login screen is active.

**Code:** `packages/client-ink/src/phases/ConnectionsPhase.tsx`

### Discord Rich Presence (DiscordSettingsPhase)

Reached from Settings → Discord. A full-screen page (title bar: "Discord", built from the same `ThemedHorizontalBorder` + `ThemedSideFrame` shell as the other phases) that lets the player enable or disable Discord Rich Presence. The description reads: "Show your current adventure on Discord? Your campaign name and a brief AI-generated status will be visible to your Discord friends." Two options are shown with radio-style markers (`◆` selected, `○` unselected): **Enable** and **Disable**, with the option matching the current setting pre-selected on open.

**Keyboard:** Up/Down move the cursor; Enter saves the selection and returns to SettingsPhase; Escape returns without saving.

**Persistence:** on Enter, the client calls `PUT /manage/discord` with `{ enabled }` (api-client.ts `setDiscordSettings`); the value is stored server-side in `discord-settings.json`. On entry, the client fetches the current value via `GET /manage/discord` (`getDiscordSettings`) to initialize the cursor.

**Code:** `packages/client-ink/src/phases/DiscordSettingsPhase.tsx`, entered from SettingsPhase via `onDiscord`.


## DM Tool Interface

The DM controls the UI through these tools:

**`update_modeline`** — Set modeline content. `character` names the target character; omit to target the active character (resolved from `config.players[activePlayerIndex]`). Freeform text string (supports inline `<b>`, `<i>`, `<u>`, `<color=#hex>` tags).
```
update_modeline({ text: "HP: 42/42 | Loc: The Shattered Hall | Conditions: Poisoned" })
update_modeline({ text: "HP: 18/30 | Exhausted", character: "Mira" })
```

**`style_scene`** — Style the UI to match the scene mood. Use `description` for natural-language requests (a Haiku stylist subagent picks theme, colors, and effects). Use `key_color` for direct hex-color changes. Optionally persist to a location entity.
```
style_scene({ description: "cyberpunk neon" })
style_scene({ key_color: "#8844aa", save_to_location: true, location: "the-shattered-hall" })
style_scene({ description: "haunted forest", variant: "exploration" })
```

**`set_display_resources`** — Update which resource keys appear in the top frame for a character. Stores keys on `GameState.displayResources`.
```
set_display_resources({ character: "aldric", resources: ["HP", "Spell Slots", "Ki"] })
```

**`set_resource_values`** — Set current values for tracked resources. Values are merged into `GameState.resourceValues` and combined with display keys to produce formatted strings like `"HP 24/30"` in the top frame.
```
set_resource_values({ character: "aldric", values: { "HP": "24/30", "Spell Slots": "3/4" } })
```

**`present_choices`** — Show a choice modal. No parameters = Haiku subagent generates options from recent context. Explicit parameters override.
```
present_choices({})
present_choices({ prompt: "The passage forks.", choices: ["Left", "Right", "Listen"] })
```

**`show_character_sheet`** — Open the character sheet modal for a character (OOC/Dev Mode only).
```
show_character_sheet({ character: "aldric" })
```

The DM does not need tools for the activity line (automatic), player selector (engine-managed), input line (player-managed), session recap (automatic on resume), or game menu (ESC key, player-managed).
