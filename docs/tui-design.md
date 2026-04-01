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
| Player's turn (idle) | *(hidden)* | *(hidden)* |

The modeline glyph column is used when the activity line has been dropped due to viewport size (see [Responsive Design](#responsive-design)). The glyph appears at the start of the modeline.


## DM Text Formatting

The DM can use a small set of inline tags in narration for dramatic effect. These are processed through a single AST-based pipeline (`processNarrativeLines`) and rendered as Ink components.

Available tags:
- `<b>`, `<i>`, `<u>` — bold, italic, underline
- `<center>`, `<right>` — text justification (default is left)
- `<color=#hex>` — hex color (e.g., `<color=#cc0000>The King has died.</color>`)

The DM prompt includes one line: *"You can use `<b>`, `<i>`, `<u>`, `<center>`, `<right>`, and `<color=#hex>` tags in your narration for dramatic effect. Use sparingly."*

Unrecognized tags are stripped. Malformed tags render as plain text. This is cosmetic — no tag changes game state.

### Formatting Pipeline

All DM text processing flows through `processNarrativeLines(lines, width, quoteColor?) → ProcessedLine[]`:

1. **Heal** cross-line tags on raw strings (all formatting tags persist across source lines; only real paragraph boundaries — blank DM lines from `\n\n` — reset the tag stack; visual spacers from single `\n` don't reset)
2. **Parse** healed text into `FormattingNode[]` AST via `parseFormatting`
3. **Wrap** each AST at terminal width via `wrapNodes` (tags never break across lines)
4. **Pad** alignment lines (`<center>`, `<right>`) with blank lines for breathing room
5. **Quote highlight** with paragraph-scoped reset (blank DM lines reset quote state)

Non-DM lines (player, dev, system) pass through without entering the formatting pipeline.

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

| Theme | Genre tags | Height | Feel |
|---|---|---|---|
| `gothic` | grimdark, horror, dark_fantasy | 2 | Double-line box-drawing, muted colors |
| `arcane` | high_fantasy, epic | 2 | Ornate Unicode flourishes |
| `terminal` | sci-fi, cyberpunk | 1 | Single-line ASCII |
| `clean` | modern, freeform | 1 | Minimal borders |

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

Below 80×25, the game replaces the entire UI with a fullscreen `TerminalTooSmall` blocker showing the current dimensions, the minimum required (80×25), and "Resize your terminal to continue." The blocker clears automatically when the terminal is resized above the minimum. Both `PlayingPhase` and `SetupPhase` enforce this.

**Code:** `src/tui/components/TerminalTooSmall.tsx`, checked in `src/phases/PlayingPhase.tsx` and `src/phases/SetupPhase.tsx`

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
▲  > ◆ Left — you hear running water
▼    ◆ Right — a draft smells of smoke
     ◆ Listen carefully first
     ◆ Enter your own...

                            ESC dismiss
```

**`present_choices`** — The DM's tool for this. Two modes:

No parameters (default): A Haiku subagent reads recent context and generates 2-3 reasonable options. Cheap, fast, doesn't need to be brilliant — freeform is always available. When fewer than 5 options are shown, focus defaults to "Enter your own" so the player can freely type and press Enter without navigating.

```
present_choices({})
→ subagent generates options from recent context, displays modal
```

Explicit choices: The DM sets specific options when it matters narratively. Optional `descriptions` provide per-choice detail shown in a fixed-height region (3 rows) that updates as the player highlights each option.

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

Player-accessible via ESC menu → Compendium. Displays a navigable tree of everything the player has learned, organized into five categories: Characters, Places, Storyline, Lore, Objectives.

**Navigation**: Up/Down arrows move cursor, Enter on category expands/collapses, Enter on entry shows detail view, ESC in detail goes back, ESC in tree closes modal.

**Detail view**: Shows entry summary, aliases, scene range, and related entries.

**Data source**: `campaign/compendium.json`, maintained by a Haiku subagent at scene transitions. Player-facing only — no DM secrets.

**Code:** `src/tui/modals/CompendiumModal.tsx`

### Session Recap

On `session_resume`, the "Previously on..." summary displays as a modal before gameplay begins. Sets the mood and reminds the player where they left off.

### Game Menu

ESC key opens the game menu modal:

```
╔══════════════════════╗
║     ◆ Resume         ║
║     ○ Character Sheet ║
║     ○ Compendium     ║
║     ○ Player Notes   ║
║     ○ OOC Mode       ║
║     ○ Settings       ║
║     ○ Save & Exit    ║
║     ○ End Session    ║
╚══════════════════════╝
```

Standard navigation (arrow keys + Enter). "Save & Exit" persists state and returns to the main menu. "End Session" runs full session-end housekeeping (transcript, summary, git commit) then returns to menu. Settings covers choice frequency, display preferences, and other player-level configuration. OOC Mode from here is equivalent to the DM detecting an OOC request.

### Player Notes

Player-accessible via ESC menu → Player Notes. Opens a simple multi-line plain-text editor. Saves on ESC close. Persisted to `campaign/player-notes.md`.

The editor handles arrow navigation, home/end (Ctrl+A/E), horizontal scroll for long lines, and vertical scroll within the modal. Uses CenteredModal's `rawRows` mode for custom cursor rendering (inverse video) while reusing the shared modal frame.

**Code:** `src/tui/modals/PlayerNotesModal.tsx`

### Color Swatch Modal

The `/swatch` command opens a debug modal showing the full harmony swatch grid, column step indices, row anchor labels (0, 100, 200, ...), and current `colorMap` assignments. Useful for tuning color maps and verifying swatch generation. Dismissed with any key.

**Code:** `src/tui/modals/SwatchModal.tsx`

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

**Code:** `src/tui/components/FullScreenFrame.tsx`


## DM Tool Interface

The DM controls the UI through these tools:

**`update_modeline`** — Set modeline content. Freeform text string.
```
update_modeline({ text: "HP: 42/42 | Loc: The Shattered Hall | Conditions: Poisoned" })
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
