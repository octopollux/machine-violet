# TUI Design

The TUI is a single Ink (React for CLI) application. The aesthetic target is "prettier than Claude Code, not quite as crazy as Cogmind." The DM agent manipulates the UI directly via tools — there is no abstraction layer between engine and interface.

## Layout

Full layout at ≥80 columns, ≥40 rows. Elements listed bottom to top:

```
┌═══════════════════════════════════════════════════════════════╗
║  HP: 42/42          The Shattered Crown         Mana: 7/12  ║ ← top frame (resource display)
╠═══════════════════════════════════════════════════════════════╣
║                                                              ║
║  The door groans open onto a long hall lit by guttering      ║
║  candles, the air thick with dust and something sweeter      ║ ← DM narrative text (scrolling)
║  underneath. At the far end, a figure sits motionless        ║
║  in a high-backed chair.                                     ║
║                                                              ║
║                                                              ║
╟──────────────────────────────────────────────────────────────╢
║  Checking rules...                                           ║ ← activity line
╠══════════════════╡ Aldric's Turn ╞═══════════════════════════╣ ← lower frame (turn indicator)
║  HP: 42/42 | Loc: The Shattered Hall | Conditions: none     ║ ← modeline
╠══════════════════════════════════════════════════════════════ ╣
║  > I approach the figure cautiously, hand on my sword        ║ ← input line
╠══════════════════════════════════════════════════════════════ ╣
║  [Aldric]  Sable  Rook(AI)                                  ║ ← player selector
╚══════════════════════════════════════════════════════════════ ╝
```

### Elements

**Player selector** — Bottom row. Shows all players. Active player is highlighted. AI players marked with `(AI)`. Outside initiative, players switch with a hotkey (Tab). During initiative, the system controls who's active. Hidden in single-player.

**Input line** — Text input for the active player. Tagged with the active character name before being sent to the DM: `[Aldric] I approach the figure cautiously`.

**Modeline** — Nethack-style status line. DM-controlled via tools. Typically shows HP, location, active conditions. Content is freeform text — the DM writes whatever's relevant.

**Lower frame** — Styled horizontal separator with the current turn holder centered: `═══╡ Aldric's Turn ╞═══`. Shows `DM` when it's the DM's turn to narrate. Part of the frame style system (see below).

**Activity line** — Automatic indicators for in-flight engine operations. Not DM-controlled. See [Activity Indicators](#activity-indicators).

**DM narrative text** — Scrolling text area. The main content region. The DM's narration renders here. Supports inline formatting (see [DM Text Formatting](#dm-text-formatting)).

**Top frame** — Styled border with resource display. Shows the active character's key resources (HP + 1-2 others). See [Resource Display](#resource-display).

**Left and right frames** — Styled vertical borders. Same style system as top/bottom. Decorative — no information content. Dropped at ≤40 columns.


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
| `resolve_action` in flight | `Resolving...` | `⚔` |
| `roll_dice` in flight | `Rolling...` | `⚄` |
| Rule lookup subagent | `Checking rules...` | `📖` |
| `scene_transition` cascade | `Scene transition...` | `⟳` |
| Waiting for DM API response | `The DM is thinking...` | `◆` |
| Player's turn (idle) | *(hidden)* | *(hidden)* |

The modeline glyph column is used when the activity line has been dropped due to viewport size (see [Responsive Design](#responsive-design)). The glyph appears at the start of the modeline.


## DM Text Formatting

The DM can use a small set of inline tags in narration for dramatic effect. These are parsed from the DM's text output and rendered as Ink components.

Available tags:
- `<b>`, `<i>`, `<u>` — bold, italic, underline
- `<center>`, `<right>` — text justification (default is left)
- `<color=#hex>` — hex color (e.g., `<color=#cc0000>The King has died.</color>`)

The DM prompt includes one line: *"You can use `<b>`, `<i>`, `<u>`, `<center>`, `<right>`, and `<color=#hex>` tags in your narration for dramatic effect. Use sparingly."*

Unrecognized tags are stripped. Malformed tags render as plain text. This is cosmetic — no tag changes game state.


## Frame Style System

Frames (top, bottom, left, right) are rendered from pre-baked style definitions. Each style specifies box-drawing characters, flourishes, and optional color.

### Style selection

The campaign genre sets a default style during game init. The style has four **variants**:

| Variant | When active |
|---|---|
| `exploration` | Default — out of combat, general play |
| `combat` | During initiative (between `start_combat` and `end_combat`) |
| `ooc` | During OOC mode |
| `levelup` | During character advancement subagent |

The DM switches variants via a `set_ui_style` tool call, or the engine switches automatically on mode changes (combat start, OOC entry, etc.).

### Style definitions

Styles are shipped with the app as data. Each defines the box-drawing characters and optional ANSI colors for all four frame edges plus corners and flourishes.

```jsonc
// Example style definition (simplified)
{
  "name": "gothic",
  "genre_tags": ["grimdark", "horror", "dark_fantasy"],
  "variants": {
    "exploration": {
      "horizontal": "═",
      "vertical": "║",
      "corner_tl": "╔", "corner_tr": "╗",
      "corner_bl": "╚", "corner_br": "╝",
      "flourish": "╡ %s ╞",        // %s = centered text (turn indicator, etc.)
      "color": "#888888"
    },
    "combat": {
      "horizontal": "━",
      "vertical": "┃",
      "corner_tl": "┏", "corner_tr": "┓",
      "corner_bl": "┗", "corner_br": "┛",
      "flourish": "┫ %s ┣",
      "color": "#cc4444"
    },
    "ooc": {
      "horizontal": "─",
      "vertical": "│",
      "corner_tl": "┌", "corner_tr": "┐",
      "corner_bl": "└", "corner_br": "┘",
      "flourish": "┤ %s ├",
      "color": "#6688cc"
    },
    "levelup": {
      "horizontal": "═",
      "vertical": "║",
      "flourish": "╡ ✦ %s ✦ ╞",
      "color": "#ccaa44"
    }
  }
}
```

### Shipped styles (examples)

| Style | Genre tags | Feel |
|---|---|---|
| `gothic` | grimdark, horror, dark_fantasy | Heavy double-line borders, muted colors |
| `arcane` | high_fantasy, epic | Ornate Unicode flourishes, gold accents |
| `terminal` | sci-fi, cyberpunk | Thin single-line, green/amber monochrome |
| `rustic` | pastoral, western, low_fantasy | Simple box-drawing, warm earth tones |
| `clean` | modern, freeform | Minimal borders, no color |
| `ornate` | courtly, mystery, intrigue | Decorative corners, rich colors |

The DM can also request a custom style during gameplay (via OOC), and the setup agent can generate one during init if the genre doesn't match any shipped style.


## Responsive Design

The TUI degrades gracefully as the viewport shrinks. Elements are dropped in a fixed order to preserve the most essential information.

### Breakpoints

| Tier | Columns | Rows | Layout |
|---|---|---|---|
| **Full** | ≥80 | ≥40 | All elements visible. Left/right frames. Full activity line. |
| **Narrow** | 40–79 | ≥40 | Left/right frames dropped. All other elements present. |
| **Short** | ≥40 | 24–39 | Top frame dropped. Activity line dropped (glyph moves to modeline). |
| **Compact** | 40–79 | 24–39 | No side frames, no top frame, no activity line. |
| **Minimal** | 20–39 | 12–23 | DM text + input line only. Lower frame, modeline, and player selector also dropped. |

### Drop order (first dropped → last dropped)

1. **Left/right frames** — decorative only, first to go
2. **Top frame** (resource display) — resources still available via character sheet
3. **Activity line** — degrades to single glyph in modeline
4. **Lower frame** (turn indicator) — turn info moves to modeline prefix
5. **Modeline** — status info is lost but available on request
6. **Player selector** — active player shown in input prompt instead

At minimum viable viewport (20×12), the player sees DM narration and a text input. Everything else is available through OOC queries.

### Column responsiveness

Within a given row tier, elements also adapt horizontally:
- Modeline truncates less-important fields first (conditions → location → resources)
- Top frame drops campaign name, then right-side resources, then left-side resources
- Lower frame simplifies flourishes to plain separators
- Frame styles fall back to simple ASCII (`-`, `|`, `+`) below 40 columns


## Modals

The app is not productivity software — immersion matters. Modals use the same frame style system as the main TUI, appearing as themed bordered windows over the narrative area. They feel like part of the game world, not like dialogs.

### Character Sheet

Triggered by the player (hotkey) or the DM (tool call). Renders the active character's sheet as a styled modal. Read-only during gameplay — edits happen through game mechanics or OOC.

### Player Choices

A core UX element. The DM (or the engine) presents the player with structured options at decision points. The player picks A/B/C or types freeform.

```
╔══════════════════════════════════════╗
║  The passage forks ahead.            ║
║                                      ║
║  A) Left — you hear running water    ║
║  B) Right — a draft smells of smoke  ║
║  C) Listen carefully first           ║
║                                      ║
║  > _                                 ║
╚══════════════════════════════════════╝
```

**`present_choices`** — The DM's tool for this. Two modes:

No parameters (default): A Haiku subagent reads recent context and generates 2-3 reasonable options. Cheap, fast, doesn't need to be brilliant — freeform is always available.

```
present_choices({})
→ subagent generates options from recent context, displays modal
```

Explicit choices: The DM sets specific options when it matters narratively.

```
present_choices({
  prompt: "The creature extends a hand. Its eyes are ancient.",
  choices: [
    "Take its hand",
    "Refuse",
    "Ask its name first"
  ]
})
```

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

### Dice Roll Display

Optional, DM-triggered. For big dramatic moments — a death save, a critical hit, a skill check that determines the fate of a kingdom — the DM can display the roll result as a modal rather than inline text.

```
present_roll({ result: "Rolled d20+3: [17] → 20", label: "Death Save" })
```

This is cosmetic — the same information would appear inline otherwise. The DM uses it for pacing and emphasis.

### Session Recap

On `session_resume`, the "Previously on..." summary displays as a modal before gameplay begins. Sets the mood and reminds the player where they left off.

### Game Menu

ESC key opens the game menu modal:

```
╔══════════════════════╗
║     ◆ Resume         ║
║     ○ Character Sheet ║
║     ○ OOC Mode       ║
║     ○ Settings       ║
║     ○ Save & Quit    ║
╚══════════════════════╝
```

Standard navigation (arrow keys + Enter). Settings covers choice frequency, display preferences, and other player-level configuration. OOC Mode from here is equivalent to the DM detecting an OOC request.

### Modal behavior

- Modals overlay the narrative area, not the full screen. The modeline and player selector remain visible underneath.
- Modals inherit the active frame style variant (a combat choice modal uses the combat border style).
- Modals are dismissed with ESC (back to game), Enter (confirm selection), or the relevant hotkey.
- At minimal viewport sizes, modals take the full screen.


## DM Tool Interface

The DM controls the UI through these tools:

**`update_modeline`** — Set modeline content. Freeform text string.
```
update_modeline({ text: "HP: 42/42 | Loc: The Shattered Hall | Conditions: Poisoned" })
```

**`set_ui_style`** — Switch frame style variant, or change the base style entirely.
```
set_ui_style({ variant: "combat" })
set_ui_style({ style: "gothic", variant: "exploration" })
```

**`set_display_resources`** — Update which resources appear in the top frame for a character.
```
set_display_resources({ character: "aldric", resources: ["HP", "Spell Slots", "Ki"] })
```

**`present_choices`** — Show a choice modal. No parameters = Haiku subagent generates options from recent context. Explicit parameters override.
```
present_choices({})
present_choices({ prompt: "The passage forks.", choices: ["Left", "Right", "Listen"] })
```

**`present_roll`** — Display a dice roll as a dramatic modal instead of inline text.
```
present_roll({ result: "Rolled d20+3: [17] → 20", label: "Death Save" })
```

**`show_character_sheet`** — Open the character sheet modal for a character.
```
show_character_sheet({ character: "aldric" })
```

The DM does not need tools for the activity line (automatic), player selector (engine-managed), input line (player-managed), session recap (automatic on resume), or game menu (ESC key, player-managed).
