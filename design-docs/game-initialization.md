# Game Initialization Design

Game initialization takes the player from first launch to gameplay. After a one-time API key prompt, the entire process is agentic. The setup agent (Sonnet, instructed to be a bit dramatic) drives the conversation, offering structured choices at each step while always allowing freeform input.

## Design Principles

- **Every prompt has a default.** Repeatedly hitting Enter takes the player to a random, systemless game with a random character. Zero friction to start.
- **Options, not interrogation.** Each decision point offers 3-5 choices plus freeform input (the Claude Code pattern). The player picks one or types something else.
- **"More Choices" is always available.** If the suggestions don't inspire, the player can ask the agent to generate more.
- **Setup is dramatic.** The setup agent has personality — it's not a form wizard, it's the opening act. It sets the tone before the DM (Opus) takes over.
- **Two-tier architecture.** The Setup Agent (Sonnet) orchestrates the flow and handles finalization. The actual multi-turn conversation is delegated to a Setup Conversation subagent (Haiku) for cost efficiency. The player doesn't see the boundary — it's a seamless experience. See [subagents-catalog.md](subagents-catalog.md) §9-10.
- **Mechanical work is delegated.** PDF imports, file creation, rule parsing, and chargen mechanics run on Haiku or in code (Tier 1/2).

## Flow

### Step 0: First Launch Setup (pure TUI, no model)

First launch only. Two prompts:

1. **API key.** Centered prompt: "Enter your Anthropic API key." Validates with a test API call. Saves to `.env`.

2. **Home directory.** "Where should tui-rpg store your campaigns?" Displays the platform default; the user can accept or specify a custom path.

Platform defaults are chosen to land inside folders that typically sync to cloud backup if enabled:

| Platform | Default path | Rationale |
|---|---|---|
| Windows | `%USERPROFILE%\Documents\.tui-rpg\` | Inside Documents, which OneDrive backs up by default |
| macOS | `~/Documents/.tui-rpg/` | Inside Documents, which iCloud Drive backs up by default |
| Linux | `~/.local/share/.tui-rpg/` | XDG data directory (no cloud default, but the conventional location) |

All campaign directories, cached rule systems, app configuration, and persistent state live under this root. The path is saved to the app's config file (stored alongside the `.env`) and used for all subsequent launches.

```
.tui-rpg/                         # home directory
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
  │   ◆ Start a new campaign    │
  │   ○ Continue a campaign     │
  │   ○ Just jump in            │
  │                             │
  └─────────────────────────────┘
```

- **Continue** → lists existing campaign directories, player picks one → `session_resume` → gameplay.
- **Just jump in** → fast path (see below).
- **Start a new campaign** → full setup flow (see below).

### Step 2a: "Just Jump In" Fast Path

Optimized for minimum prompts to gameplay. Enter = random/default at every step.

```
Agent: "What kind of world?"

  ◆ Classic fantasy
  ○ Sci-fi
  ○ Modern supernatural
  ○ Post-apocalyptic
  ○ More choices...

[Enter = random pick]
```

```
Agent: "What game system?"

  ◆ No system — pure narrative          [always first]
  ○ FATE Accelerated — light mechanics
  ○ 24XX — minimal dice
  ○ More choices...

[Enter = no system]
```

```
Agent: "Your Dungeon Master?"

  ◆ The Chronicler — measured, literary,
    loves foreshadowing and callbacks
  ○ The Trickster — chaotic, surprising,
    delights in unlikely turns
  ○ The Warden — fair but unforgiving,
    the world doesn't care about your feelings
  ○ More choices...

[Enter = random pick]
```

```
Agent: "Who are you?"

  ◆ Kael, a wandering sellsword with a
    debt and a bad reputation
  ○ Sister Venn, excommunicated healer
    searching for a forbidden cure
  ○ Rook, a thief who accidentally stole
    something that matters
  ○ More choices...

[Enter = random pick]
```

Four prompts (or zero, if you mash Enter). The agent creates the campaign directory, writes a minimal character file, picks a starting scenario, and hands off to the DM. Player is in the game in under a minute.

### Step 2b: Full Setup Flow

For players who want to configure their experience.

**Game system:**
```
Agent: "What system shall we play?"

  ○ D&D 5e
  ○ FATE
  ○ Ironsworn
  ○ I have a rulebook (PDF)
  ○ No system — freeform
  ○ More choices...
```

- Known free system → fetch SRD at runtime, Haiku parses into rule files and distilled cards
- PDF → document import pipeline (normal or batch, per [document-ingestion.md](document-ingestion.md))
- No system → text adventure mode or hidden 24XX

**Campaign source:**
```
Agent: "What kind of adventure?"

  ○ I have a campaign book (PDF)
  ○ Surprise me — build a world
  ○ The Shattered Crown        [seed]
  ○ Ghosts of Station Proxima  [seed]
  ○ The Gilded Cage             [seed]
  ○ More choices...
```

- Campaign PDF → import pipeline, DM cheat sheet generated
- Surprise me → agent asks follow-up questions (see below)
- Seed → minimal evocative premise, the DM fleshes it out

If "Surprise me":
```
Agent: "Set the mood."

  ○ Heroic — glory and triumph
  ○ Grimdark — survival and hard choices
  ○ Whimsical — humor and wonder
  ○ Tense — mystery and paranoia
  ○ More choices...
```

```
Agent: "How forgiving should I be?"

  ○ Gentle — the story goes on
  ○ Balanced — consequences, but fair
  ○ Unforgiving — death is real
```

**DM personality:**
```
Agent: "Who will be your Dungeon Master?"

  ○ The Chronicler — measured, literary,
    loves foreshadowing and callbacks
  ○ The Trickster — chaotic, surprising,
    delights in unlikely turns
  ○ The Warden — fair but unforgiving,
    the world doesn't care about your feelings
  ○ The Bard — warm, character-driven,
    every NPC has a story
  ○ More choices...
```

See [DM Personalities](#dm-personalities) below for how this works under the hood.

**Player info:**
```
Agent: "Anything I should know about you as a player?"

  ○ First time playing a tabletop RPG
  ○ Experienced player, just have fun
  ○ I'd like to avoid [content boundaries]
  ○ Skip — let's just play
```

Responses go into `players/[name].md`.

**Character creation:**
- For crunchy systems (5e, etc.): handed off to a player-facing Haiku subagent with the system's chargen rules. Full mechanical walkthrough — race, class, stats, background, equipment.
- For light/no system: conversational. "Describe your character in a few words" or pick from generated options. Produces a minimal character file.
- In both cases, the player can pick from suggestions or go freeform.

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

Seeds are minimal — just evocative names and a one-sentence premise. They're "names from a hat" that the DM expands into a full world. Shipped with the app, numerous enough that players see fresh options.

Examples:
```
The Shattered Crown — A kingdom's heir is dead. Three factions claim the throne.
Ghosts of Station Proxima — An abandoned space station just started broadcasting again.
The Gilded Cage — You're the guest of honor at a party you can't leave.
Hollowdeep — A mining town's deepest shaft broke into something old.
The Last Caravan — Civilization is a month's ride behind you, and gaining.
Red Tide — The fishing village's catch is rotting before it reaches shore.
The Instrument — You found a weapon. It found you first.
```

The DM receives the seed as a starting premise and builds the world around it. Seeds are genre-tagged so the setup agent can filter them by the player's genre choice.

## DM Personalities

The player picks a DM personality during setup — like choosing a narrator in Rimworld. Under the hood, this swaps a personality block into the DM's system prompt. The core DM prompt (role, rules, tool usage) stays the same; the personality block adjusts voice, pacing preferences, and storytelling tendencies.

Personalities are stored as short prompt fragments shipped with the app. Each is ~100-200 tokens — cheap enough to include in the cached prefix with no meaningful cost impact.

### Shipped personalities (examples)

**The Chronicler** — measured, literary, loves foreshadowing and callbacks.
```
You are The Chronicler. Your narration is deliberate and layered. You plant details
early and pay them off later. You favor atmosphere over action, and your descriptions
carry weight. You track recurring motifs. When something terrible happens, you
describe it with quiet precision, not bombast. You remember everything.
```

**The Trickster** — chaotic, surprising, delights in unlikely turns.
```
You are The Trickster. You love the improbable. When rolling for narrative outcomes,
weight the unusual options more heavily — the boring result is never your first choice.
You delight in consequences the player didn't see coming, but you always play fair:
the clues were there. Your NPCs have agendas that surprise even you. Tone shifts
are your favorite tool.
```

**The Warden** — fair but unforgiving, the world has its own logic.
```
You are The Warden. The world runs on its own rules and does not bend for the player.
Choices have consequences that ripple. You don't punish, but you don't protect either.
Your narration is direct and unadorned — you state what happens. When the player asks
"can I do this?", your answer is always "you can try." Success is earned. NPCs act
in their own interest, not the player's story.
```

**The Bard** — warm, character-driven, every NPC has a story.
```
You are The Bard. Characters are your canvas. Every NPC, no matter how minor, has
a voice and a want. You linger on dialogue and relationships. Combat is brief;
its aftermath is where the story lives. You find the emotional core of every scene.
You give the player's character moments of vulnerability and connection. The world
is lived-in and human-scale.
```

### Custom personalities

The "More choices..." option in setup lets the player describe a DM personality in their own words. The setup agent writes a prompt fragment from the description and saves it. Players can also pick a shipped personality and modify it.

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
| Setup orchestration | Sonnet | Handles finalization and campaign directory creation |
| Conversational setup | Haiku | Multi-turn player conversation delegated to Haiku for cost efficiency |
| PDF import (extraction) | Haiku (vision) | Cheap, handles complex layouts |
| PDF import (organization) | Haiku | Mechanical sorting into filesystem |
| Rule card distillation | Haiku | Compression task, no creativity needed |
| Character creation (crunchy) | Haiku (player-facing subagent) | Mechanical, follows rules |
| Character creation (freeform) | Sonnet | Part of the conversational flow |
| World building | Sonnet | Creative but not the main DM |
| DM cheat sheet generation | Haiku | Summarization task |
| Opening narration | Opus (the DM) | First in-game moment — this is where quality matters |
