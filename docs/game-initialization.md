# Game Initialization Design

Game initialization takes the player from first launch to gameplay. After a one-time API key prompt, the entire process is agentic. The setup agent (Sonnet, instructed to be a bit dramatic) drives the conversation, offering structured choices at each step while always allowing freeform input.

## Design Principles

- **Single conversational path.** There is one "New Campaign" entry point, with the setup agent offering Quick Start or Full Setup within the conversation. No separate code paths.
- **Options, not interrogation.** Each decision point offers 2-10 choices via `present_choices`, plus freeform input via "Enter your own". The player picks one or types something else. When fewer than 5 options are shown, focus defaults to "Enter your own" so the player can freely type.
- **"Show me more ideas" is always available.** Every `present_choices` call includes this as the last option. The app automatically prepends "Enter your own" above the list as the first option.
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

The main menu uses the full themed frame (same border components as the playing UI). Campaign titles are read from each campaign's `config.json`.

- **Continue** → expands an inline sub-list of campaigns (by title). Each row is column-navigable (see below) → resume → gameplay.
- **New Campaign** → setup conversation (see below).
- **Quit** → exits the process.

"Continue Campaign" only appears in the main menu when at least one campaign exists.

Returning from a game via "Save & Exit" or "End Session" runs teardown (graceful shutdown + cache reset) and transitions back to this menu.

#### Campaign sub-list columns

When "Continue Campaign" is selected and campaigns exist, the menu expands an inline sub-list. Each campaign row has three keyboard-navigable columns:

| Column | Default | Enter action |
|---|---|---|
| Name | yes (◆) | Resume the campaign, collapse the sub-list |
| Archive (yellow) | — | Archive the campaign immediately, collapse the sub-list |
| Delete (red) | — | Open the Delete Campaign confirmation modal |

- **Left/Right** arrows cycle columns within the selected row (clamped at the ends).
- **Up/Down** arrows move between campaign rows. Up from the first row collapses the sub-list and reselects "Continue Campaign"; Down from the last row collapses it and advances to the menu item below "Continue Campaign" — so the sub-list reads as woven into the main menu rather than a one-way trap.
- **ESC** collapses the sub-list.

The archive action calls `archiveCampaign()` from [campaign-archive.ts](../packages/engine/src/config/campaign-archive.ts) — zip → verify round-trip → move → verify → delete source. The delete action opens the confirmation modal (below), populated with summary data from `getCampaignDeleteInfo()` before any files are removed. Source: [packages/client-ink/src/phases/MainMenuPhase.tsx](../packages/client-ink/src/phases/MainMenuPhase.tsx).

#### Delete Campaign modal

Opened from the Delete column. It shows a read-back of what is about to be removed and requires explicit confirmation:

- **Campaign name**, character list (comma-separated, or `(none)`), and an approximate DM turn count (`getCampaignDeleteInfo` counts DM turn-blocks in the display log).
- The line "This cannot be undone."
- `[Delete]` / `[Cancel]` buttons — Left/Right arrows toggle between them; the selection **defaults to Cancel**.

Enter confirms the selected button; **ESC always cancels**. While the modal is open it owns keyboard input, so the underlying menu does not navigate. Source: [packages/client-ink/src/tui/modals/DeleteCampaignModal.tsx](../packages/client-ink/src/tui/modals/DeleteCampaignModal.tsx).

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
3. Campaign scope (`one-shot` | `few-sessions` | `grand-campaign` | `open-ended`) — bakes intended length into `config.json` so the DM can pace accordingly. Skipped when the chosen seed declares a required scope.
4. Mood
5. Difficulty
6. DM personality
7. Character (name + one-sentence concept)
8. Player name
9. Game system
10. Mechanics handling — **only when a light/ultra-light system was chosen**: the agent asks whether the player wants to use the mechanics themselves (`player-facing`) or have the DM run them silently behind the scenes (`dm-managed`, the default). Recorded as `config.json` `mechanics_mode`. Skipped for crunchy systems (implicitly player-facing) and pure-narrative campaigns. See [rules-systems.md](rules-systems.md#mechanics-mode-player-facing-vs-dm-managed).

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
12. **Write or update the machine-scope player file** — `~/.machine-violet/players/<player-slug>.md` persists across campaigns and is touched on every campaign creation (only when `homeDir` is available). See [Player file](#player-file-machine-scope) below.
13. **Copy character portrait** — if the setup agent confirmed a portrait during chargen (its `set_portrait` tool wrote one), copy it from the `__setup__` scratch campaign into the new campaign's `characters/` directory. The no-portrait case (player declined image generation, or `set_portrait` was never called) is silently skipped. See [Portrait handoff](#portrait-handoff-at-campaign-creation) below.
14. **Materialize rich seed content** — if the campaign was built from a `.mvworld` that ships inline content (NPCs, locations, factions, lore, items, maps, rules, calendar), re-load it by slug and write it straight to disk via `materializeWorldContent`. This runs entirely in code — the entity tree never passes through the setup agent's context. The player-facing compendium and the PC sheet are deliberately *not* seeded. See [format-spec.md §10.5](format-spec.md) for the field-by-field mapping and the `build-mvworld` skill for authoring seeds from played campaigns.

`buildCampaignWorld` in [packages/engine/src/agents/world-builder.ts](../packages/engine/src/agents/world-builder.ts) performs all of these steps. The character file, party file, player file, and portrait copy are emitted alongside the directory scaffold and `config.json`; rich seed content (step 14) is materialized last.

### Step 4: Handoff to the DM

The setup agent's work is done. The app starts the main DM agent loop (Opus) with:
- DM system prompt loaded
- Campaign directory fully populated
- Cached prefix built (rules, campaign summary, location, character sheets, clocks)
- Empty conversation history

The DM's first message is the opening narration. `startNewGame` (in [session-manager.ts](../packages/engine/src/server/session-manager.ts)) kicks it off with a synthetic, transcript-skipped **priming message** — the only turn the DM doesn't react to real player input. Its layout:

1. A bracketed stage direction: `[Session begins. Set the scene. Campaign premise: … The player character is …. <opening scene>.]` — the cue the DM is trained to react to. When the setup agent declared an opening scene at finalize (`config.opening_scene`), its one sentence is dropped into the bracket **verbatim** — no wrapping instruction. It counters the DM's default pull toward dropping the player straight onto the main objective: most campaigns should open on a character-grounded beat, then let plot arrive. The setup agent owns this because it has the whole picture (premise + PC + player intent + any seed hint), and the DM's "you are a DM" vector doesn't steer toward "put the player in a warm bed first." The setup agent's sentence *is* the directive — the DM gets no extra static prompting on the matter.
2. The **handoff note** (if present): `config.setup_handoff` verbatim — the player's own words and setup-agent notes that don't survive into structured config.
3. A **Pre-existing entities** block — the chain-of-custody listing so the DM writes to existing entity files instead of creating duplicates.

`opening_scene` and `setup_handoff` are both one-shot reads injected only on this turn; they persist in `config.json` purely so a mid-first-turn crash can replay the same priming on resume. Neither is re-injected once the opening narration succeeds. The game begins.

### Player file (machine-scope)

The player file at `~/.machine-violet/players/<player-slug>.md` lives outside any campaign directory and persists across campaigns. `buildCampaignWorld` touches it on every campaign creation, provided a `homeDir` is available. Its `## Content Boundaries` section is built from the captured age group plus any content preferences: a `child` age group seeds the section with no profanity / no sexual content / no graphic violence; a `teenager` age group seeds a discretion cut on sexual content; freeform content preferences are appended as bullet lines.

- **New player (no file yet):** creates the file with `type: Player` front matter. `age_group` is written to front matter only if it was captured during this setup run. A `## Content Boundaries` body section is written only if it would be non-empty (the age group implies defaults, or preferences were captured); otherwise the body is left empty.
- **Returning player (file exists):** the existing file is read with `parseFrontMatter`, and two conditional updates are applied:
  - `age_group` is added to front matter only if it is not already present **and** was provided in this run.
  - A `## Content Boundaries` section is appended to the body only if no such section already exists **and** this run captured preferences or an age group (and the resulting section is non-empty). Existing content boundaries are never overwritten — this preserves accumulated cross-campaign knowledge while backfilling newly captured metadata.
  - The file is rewritten (via `serializeEntity`) only if at least one of these changes applied; otherwise it is left untouched.

This step is handled by `buildCampaignWorld` → `updateReturningPlayer` in [packages/engine/src/agents/world-builder.ts](../packages/engine/src/agents/world-builder.ts). See [entity-filesystem.md](entity-filesystem.md) for the player-file format.

### Portrait handoff at campaign creation

The setup agent's `set_portrait` tool writes the confirmed character portrait into the `__setup__` scratch campaign's `characters/` directory (as `<character-slug>-portrait.png`) — not directly into the real campaign. The transfer to the live campaign happens inside `buildCampaignWorld`: after scaffolding the new campaign directory, it reads `<campaignsDir>/__setup__/characters/<character-slug>-portrait.png` and writes it to the new campaign's `characters/<character-slug>-portrait.png` (the path returned by `campaignPaths(...).characterPortrait`). This copy only runs when the FileIO implementation exposes binary read/write.

If the source file is absent — the player declined image generation, or `set_portrait` was never called — the copy is silently skipped and the campaign starts without a portrait. A read/write failure mid-copy is likewise non-fatal: the campaign succeeds and the DM context injection simply finds no portrait to inject for that PC. This copy is the bridge between the setup agent's chargen path and the canonical portrait location that the DM-context portrait injection reads.

## Campaign Seeds

Seeds are evocative names with a one-sentence premise. Shipped with the app in `src/config/seeds.ts`, numerous enough that players see fresh options. Genre-tagged so the setup agent can filter by player choice.

Seeds are injected into the setup conversation's system prompt so the agent can present them as game ideas during Quick Start.

### Seed format

Seeds are `.mvworld` files (canonical schema: [format-spec.md §10](format-spec.md)). Each has a public face (name, summary, genres) and optional DM-only material: a fork-invariant `detail` base and named **forks** — the decision points by which one seed encodes many possible campaigns ([format-spec.md §10.6](format-spec.md)).

**Forks resolve entirely at setup.** Via `load_world`, the setup agent receives a world's forks split by `chooser`:

- **Player forks** (`chooser: "player"`) — presented to the player via `present_choices` (starting faction, who-you-are picks, tone dials).
- **Agent forks** (`chooser: "agent"`) — decided by the setup agent itself, DM-only (the genre wrapper, secret variants). The agent uses the `roll_dice` tool (`1dN`) to pick at random or chooses to fit the player; the player never sees these.

The setup agent reports every resolution in `finalize_setup.fork_selections` (`forkId → optionId`). `load_world` does **not** return the DM-only premise prose — `handleFinalize` assembles `campaign_detail` in code from the seed's base + the selected branches (`assembleCampaignDetail`), so the agent never carries it and the DM is born into a single collapsed variant with no unchosen branches in context. The selections persist as `config.fork_selections`. Legacy `suboptions` are folded into player forks on load.

## DM Personalities

The player picks a DM personality during setup — like choosing a narrator in Rimworld. Under the hood, this swaps a personality block into the DM's system prompt. The core DM prompt (role, rules, tool usage) stays the same; the personality block adjusts voice, pacing preferences, and storytelling tendencies.

Personalities are stored as short prompt fragments shipped with the app. Each is ~100-200 tokens — cheap enough to include in the cached prefix with no meaningful cost impact.

### Shipped personalities

The canonical roster lives in [personalities/](../personalities/) at the repo root — one `.mvdm` file per personality, parsed by [packages/engine/src/config/personality-loader.ts](../packages/engine/src/config/personality-loader.ts). Each file carries a `format: "machine-violet-dm"` envelope plus the `name`, `description`, `prompt_fragment`, and optional `detail` fields. Read the directory for the current list; the roster has grown well past the original four (Chronicler / Trickster / Warden / Bard) and is curated rather than counted, so treat the files as the source of truth and avoid mirroring the list here. Users can drop additional `.mvdm` files into `~/.machine-violet/personalities/` to add their own.

### Custom personalities

The "Enter your own" option in setup lets the player describe a DM personality in their own words. The setup agent writes a prompt fragment from the description and saves it.

### Storage

The selected personality fragment is stored in `config.json` and woven into the DM system prompt by `buildDMPrefix`, which reads `config.dm_personality` **live at the start of every DM turn**.

### Changing personality mid-campaign

Supported via three registry tools (available to the DM and OOC):

- `list_dm_personalities` — the same persona catalog the setup agent sees (`loadAllPersonalities`), surfaced in-game so the agent knows the options.
- `swap_dm_personality({ name, prompt_fragment?, detail?, description? })` — switch to a preset by `name`, or invent a custom persona by also passing `prompt_fragment`. Writes `config.dm_personality` and persists `config.json`.
- `howto_swap_dm_personality` — the playbook (list → present → swap → in-fiction handoff).

Because the personality is read live each turn (not snapshotted like `pcSheets`), the swap takes effect on the **next** DM turn with no reload — that turn pays a one-time prompt-cache recreation, then re-caches at BP1. The incoming persona is expected to open with an in-fiction voice handoff so the shift reads as intentional. See [tools-catalog.md](tools-catalog.md#dm-personality-tools).

```jsonc
// config.json (partial)
{
  "campaign_scope": "few-sessions",
  "opening_scene": "Open with the PC asleep in a hayloft, woken by a stranger saddling a horse below.",
  "setup_handoff": "Player leans noir-burnout, loves ensemble scenes. I promised a talking cat.",
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
