# Game Initialization Design

Game initialization takes the player from first launch to gameplay. After a one-time API key prompt, the entire process is agentic. The setup agent (Sonnet, instructed to be a bit dramatic) drives the conversation, offering structured choices at each step while always allowing freeform input.

## Design Principles

- **Single conversational path.** There is one "New Campaign" entry point, with the setup agent offering Quick Start or Full Setup within the conversation. No separate code paths.
- **Options, not interrogation.** Each decision point offers 2-5 choices via `present_choices`, plus freeform input via "Enter your own". The player picks one or types something else.
- **"Show me more ideas" is always available.** Every `present_choices` call includes this as the last option. The app automatically appends "Enter your own" below it.
- **Pre-finalize review is mandatory.** Before calling `finalize_setup`, the agent reads back the full configuration in natural language and asks the player to confirm or request changes.
- **Setup is dramatic.** The setup agent has personality — it's not a form wizard, it's the opening act. It sets the tone before the DM (Opus) takes over.
- **Mechanical work is delegated.** PDF imports, file creation, rule parsing, and chargen mechanics run on Haiku or in code.

## Flow

### Step 0: First Launch Setup (pure TUI, no model)

First launch only. One prompt:

1. **API key.** Centered prompt: "Enter your Anthropic API key." Validates with a test API call. Saves to `.env`.

Home directory uses platform defaults automatically — no interactive prompt. Platform defaults are chosen to land inside folders that typically sync to cloud backup if enabled:

| Platform | Default path | Rationale |
|---|---|---|
| Windows | `%USERPROFILE%\Documents\.machine-violet\` | Inside Documents, which OneDrive backs up by default |
| macOS | `~/Documents/.machine-violet/` | Inside Documents, which iCloud Drive backs up by default |
| Linux | `~/.local/share/.machine-violet/` | XDG data directory (no cloud default, but the conventional location) |

All campaign directories, cached rule systems, app configuration, and persistent state live under this root. The path is saved to the app's config file (stored alongside the `.env`) and used for all subsequent launches.

```
.machine-violet/                         # home directory
├── campaigns/
│   ├── the-shattered-crown/      # one campaign
│   └── ghosts-of-proxima/        # another campaign
├── rules-cache/                  # fetched/parsed SRDs, shared across campaigns
└── config.json                   # app-level settings (home dir, default preferences)
```

Subsequent launches skip Step 0 entirely.

### Step 1: New or Continue? (pure TUI)

```
  ┌─────────────────────────────┐
  │                             │
  │   ◆ New Campaign            │
  │   ○ Continue Campaign       │
  │   ○ Quit                    │
  │                             │
  └─────────────────────────────┘
```

- **Continue** → lists existing campaign directories, player picks one → `session_resume` → gameplay.
- **New Campaign** → setup conversation (see below).

### Step 2: Setup Conversation

The setup agent welcomes the player with flair and offers two paths via `present_choices`:

#### Quick Start Path

1. Agent presents 4-5 campaign seeds as game ideas
2. Player picks one, selects "Show me some more ideas" for different options, or types their own idea
3. Agent auto-fills remaining options (genre inferred from seed, default mood/difficulty/system/personality)
4. Agent presents a natural-language summary of the configuration
5. Player confirms or requests changes
6. Agent asks for character (name + concept) and player name
7. `finalize_setup`

#### Full Setup Path

Conversational flow — the agent asks about each topic one or two at a time:

1. Genre/setting
2. Campaign concept (seeds offered via `present_choices`, or freeform)
3. Mood
4. Difficulty
5. DM personality
6. Character (name + one-sentence concept)
7. Player name
8. Game system

Both paths include a mandatory pre-finalize review where the agent reads back the full configuration and gets explicit confirmation.

### Step 3: World Setup (behind the scenes)

Once the setup agent has enough information, it builds the campaign. This is mostly Tier 1 (file creation) and Tier 2 (Haiku) work:

1. **Create campaign directory** — standard folder structure per [entity-filesystem.md](entity-filesystem.md)
2. **Write `config.json`** — system, mood, difficulty, calendar format, context management settings
3. **Initialize clocks** — calendar epoch, display format per [clocks-and-alarms.md](clocks-and-alarms.md)
4. **Write rule files** — if a system was selected, distilled rule cards are ready from the import step
5. **Build starting location** — index file, optional map
6. **Create initial NPCs** — whoever's present at the start (minimal files, promoted on demand)
7. **Set initial alarms** — if the campaign has ticking clocks
8. **Write DM cheat sheet** — if running a campaign book
9. **Write campaign log** — first entry
10. **Generate custom tools** — exotic dice, card decks, if needed by the system
11. **Write party file** — `characters/party.md` with initial shared resources

### Step 4: Handoff to the DM

The setup agent's work is done. The app starts the main DM agent loop (Opus) with:
- DM system prompt loaded
- Campaign directory fully populated
- Cached prefix built (rules, campaign summary, location, character sheets, clocks)
- Empty conversation history

The DM's first message is the opening narration. The game begins.

## Campaign Seeds

Seeds are minimal — just evocative names and a one-sentence premise. They're "names from a hat" that the DM expands into a full world. Shipped with the app in `src/config/seeds.ts`, numerous enough that players see fresh options. Genre-tagged so the setup agent can filter by player choice.

Seeds are injected into the setup conversation's system prompt so the agent can present them as game ideas during Quick Start.

## DM Personalities

The player picks a DM personality during setup — like choosing a narrator in Rimworld. Under the hood, this swaps a personality block into the DM's system prompt. The core DM prompt (role, rules, tool usage) stays the same; the personality block adjusts voice, pacing preferences, and storytelling tendencies.

Personalities are stored as short prompt fragments shipped with the app. Each is ~100-200 tokens — cheap enough to include in the cached prefix with no meaningful cost impact.

### Shipped personalities

**The Chronicler** — measured, literary, loves foreshadowing and callbacks.
**The Trickster** — chaotic, surprising, delights in unlikely turns.
**The Warden** — fair but unforgiving, the world has its own logic.
**The Bard** — warm, character-driven, every NPC has a story.

### Custom personalities

The "Enter your own" option in setup lets the player describe a DM personality in their own words. The setup agent writes a prompt fragment from the description and saves it.

### Storage

The selected personality fragment is stored in `config.json` and loaded into the DM system prompt at session start. Changing personality mid-campaign is possible (via OOC mode) but unusual.

```jsonc
// config.json (partial)
{
  "dm_personality": {
    "name": "The Chronicler",
    "prompt_fragment": "You are The Chronicler. Your narration is deliberate..."
  }
}
```

## Model Usage During Init

| Phase | Model | Rationale |
|---|---|---|
| API key validation | Haiku | Cheapest model for a test call |
| Setup conversation | Sonnet | Multi-turn player conversation with tools |
| PDF import (extraction) | Haiku (vision) | Cheap, handles complex layouts |
| PDF import (organization) | Haiku | Mechanical sorting into filesystem |
| Rule card distillation | Haiku | Compression task, no creativity needed |
| Character creation (crunchy) | Haiku (player-facing subagent) | Mechanical, follows rules |
| World building | Sonnet | Creative but not the main DM |
| DM cheat sheet generation | Haiku | Summarization task |
| Opening narration | Opus (the DM) | First in-game moment — this is where quality matters |
