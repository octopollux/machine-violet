# Entity Filesystem Design

The game world is stored as a filesystem structure optimized for tool and agent access. The DM interacts with it through tools and direct file reads/writes. The player never sees any of it — with one exception: **PC character sheets are player-facing.** The player may ask to see their character sheet at any time. The DM must not write secrets, hidden plot information, or meta-observations about the player on a PC character sheet. That information belongs elsewhere (scene dm-notes, lore files, the campaign log, etc.).

## Core Principles

- **The campaign transcript is the knowledge backbone.** The DM discovers entities by following wikilinks in the campaign log and scene transcripts. The transcript isn't just a record — it's the DM's filesystem index.
- **Every entity reference in a transcript or campaign log entry MUST be a wikilink.** This is how the DM finds things. Dead links (pointing to files that don't exist yet) are valid — they signal "this entity exists in the fiction but hasn't been fleshed out." The Haiku scene summarizer must preserve all wikilinks when writing campaign log entries.
- **Entities are a spectrum, not categories.** A shopkeeper can start as a sentence in a transcript, become a three-line file, and later grow into a full character sheet. The file format supports the whole range. A three-line file is valid.
- **Default file type is Markdown.** Structured data (maps, character sheet stats) can use JSON alongside the markdown file. Wiki-linking between entities is encouraged everywhere.
- **Every entity file has room for a changelog.** An append-only, scene-referenced log of how the entity has changed over time. The DM can scan it to remember the full arc without re-reading transcripts.

## Entity Types

| Type | Directory | What it stores |
|---|---|---|
| **players** | `players/` | Real humans. Preferences, play style, meta-observations, triggers to avoid. |
| **characters** | `characters/` | Anyone inhabiting the world — PCs, NPCs, monsters, gods. No hard distinction between subtypes. Any character can be handed to a player to inhabit. |
| **locations** | `locations/` | Places. Description, connections to other locations, associated tile maps. Locations get subdirectories (may contain maps, sub-location files). |
| **factions** | `factions/` | Organizations, groups, armies. Goals, resources, members, relationships. |
| **lore** | `lore/` | The grab-bag. Items, history, prophecies, cultural notes, magic systems, recurring dreams, anything worth tracking that isn't a character, location, faction, or rules reference. |
| **rules** | `rules/` | Game-system mechanics extracted from source materials during initialization. Feeds adjudication, not narration. |
| **campaign** | `campaign/` | The running record. Campaign log, scene transcripts, session recaps. The knowledge backbone. |

## Folder Structure

The layout is deterministic. Tools and agents can find files by convention.

```
campaign-root/
├── campaign/
│   ├── log.md                          # THE knowledge backbone
│   │                                   # Terse running summary, dense with wikilinks
│   │                                   # Links out to scenes, entities, lore
│   ├── session-recaps/
│   │   ├── session-001.md
│   │   └── session-002.md
│   └── scenes/
│       ├── 001-tavern-meeting/
│       │   ├── transcript.md           # full gameplay transcript, wikilinked
│       │   └── dm-notes.md             # DM-only context for this scene
│       └── 002-road-to-caves/
│           ├── transcript.md
│           └── dm-notes.md
├── players/
│   └── alex.md
├── characters/
│   ├── aldric.md                       # PC, full character sheet
│   ├── mayor-graves.md                 # significant NPC, personality + stats
│   └── brennan-shopkeeper.md           # minor NPC, three lines — until it isn't
├── locations/
│   ├── thornfield-village/
│   │   ├── index.md                    # description, wiki-links to NPCs/shops/etc
│   │   └── map.json                    # tile map (see map-system.md)
│   └── goblin-caves/
│       ├── index.md
│       ├── level-1.json
│       └── level-2.json
├── factions/
│   └── iron-crown-guild.md
├── lore/
│   ├── staff-of-echoes.md              # notable item
│   ├── prophecy-of-the-black-sun.md    # plot thread
│   └── history-of-the-empire.md        # world-building
├── rules/
│   ├── core-mechanics.md
│   └── combat.md
└── config.json                         # game system, mood, settings, campaign metadata
```

### Conventions
- Locations get subdirectories (they may contain maps and sub-locations). Everything else is flat files unless it grows.
- No filename prefixes for entity subtypes. A character's type (PC, NPC, creature) lives in the file's front matter, not the filename.
- Scene directories are numbered sequentially with a short slug: `001-tavern-meeting/`.
- A character's "importance" is just how much content is in the file, not a metadata flag.

## Entity File Format

Every entity file follows the same pattern: a front-matter block, a core description, optional structured sections, and a changelog at the bottom.

### Minimal file (newly created minor NPC)

```markdown
# Brennan the Shopkeeper

**Type:** NPC
**Location:** [Thornfield Village](../locations/thornfield-village/index.md)

Retired soldier, runs a general store. Gruff but fair. Bad knee.

## Changelog
- **Scene 004**: Party bought supplies. Brennan warned them about the caves.
```

### Full file (significant NPC with history)

```markdown
# Mayor Graves

**Type:** NPC
**Location:** [Millhaven](../locations/millhaven/index.md)
**Disposition:** Hostile (fled from the party)

Graves is a Pecksniff — unctuous, self-righteous, performatively charitable.
Secretly embezzling from the village reconstruction fund. Terrified of being
found out. Will cooperate if threatened, but holds grudges forever.

Speech: Formal, lots of "my dear friend", never uses contractions.

## Relationships
- [Aldric](aldric.md): Hostile. Aldric exposed his embezzlement.
- [Iron Crown Guild](../factions/iron-crown-guild.md): Owes them money. Now that he's fled, they want it back urgently.

## Stats
*See [game system] character sheet format in [rules](../rules/core-mechanics.md).*

STR 8 / DEX 10 / CON 11 / INT 14 / WIS 13 / CHA 16
HP: 18  AC: 10
Notable: Persuasion +6, Deception +6. No combat abilities.

## Changelog
- **Scene 003**: Met the party. Gave them the goblin-caves quest to get them out of town.
- **Scene 007**: [Aldric](aldric.md) confronted him about the fund. Denied everything.
- **Scene 012**: Party returned with evidence. Graves fled to [Millhaven](../locations/millhaven/index.md).
- **Scene 015**: [Iron Crown Guild](../factions/iron-crown-guild.md) put a bounty on him.
```

### PC file

```markdown
# Aldric

**Type:** PC
**Player:** [Alex](../players/alex.md)
**Class:** Paladin 5
**Location:** [Goblin Caves, Level 2](../locations/goblin-caves/index.md)
**Color:** #4488ff

Half-elf, folk hero background. Earnest to a fault. Believes in justice
but struggles with mercy vs. expedience.

## Stats
STR 16 / DEX 10 / CON 14 / INT 12 / WIS 13 / CHA 16
HP: 42/42  AC: 18 (chain mail + shield)
...

## Inventory
- Longsword (+5 to hit, 1d8+3 slashing)
- [Staff of Echoes](../lore/staff-of-echoes.md) (attuned, properties unknown to Aldric)
- 3x healing potions
- 47 gold

## Changelog
- **Scene 001**: Created. Entered the Rusty Nail tavern in [Thornfield](../locations/thornfield-village/index.md).
- **Scene 007**: Confronted [Mayor Graves](mayor-graves.md) about the reconstruction fund.
- **Scene 010**: Found the [Staff of Echoes](../lore/staff-of-echoes.md) in the goblin hoard.
- **Session 2 level-up**: Paladin 4 → 5. Took Extra Attack. +2 CHA (ASI).
```

## The Wikilink Contract

Wikilinks are the connective tissue of the entire system. Rules:

1. **Every entity mention in a transcript or campaign log entry is a wikilink.** No exceptions. This is how the DM discovers and rediscovers entities.
2. **Dead links are valid.** A link to `characters/mysterious-stranger.md` that doesn't exist yet means "this entity is in the fiction but hasn't been fleshed out." The DM can create the file later, or never.
3. **The Haiku scene summarizer preserves all wikilinks** when writing campaign log entries. If it drops a link, the DM loses its path to that entity.
4. **Links use relative paths.** A character file links to a location as `../locations/thornfield-village/index.md`. This keeps the campaign directory portable.
5. **Entities wikilink to each other.** A character's relationships section links to other characters and factions. A location links to characters found there. The filesystem becomes a navigable web.

## Character Promotion

Characters exist on a spectrum of detail. The DM can promote any character from minimal to full at any time using a tool:

```
promote_character({
  name: "Brennan",
  file: "characters/brennan-shopkeeper.md",   // or null to create new
  level: "full_sheet",                         // "minimal" | "full_sheet"
  context: "Player attacked him. Need combat stats. He's a retired soldier
            running a shop, tough but out of practice."
})
```

This is a Haiku subagent job:
1. Read the game system's rules for character/NPC creation
2. Read any existing notes on the character
3. Generate an appropriate character sheet based on the DM's context hint
4. Write or update the file, preserving existing content and changelog
5. Return a confirmation to the DM

The reverse is also natural: a character who was important can fade into irrelevance. The file stays (the changelog is historical record), but the DM simply stops linking to it in new transcripts.

## Changelog Automation

The `scene_transition` tool should trigger changelog updates as part of its housekeeping cascade:

**Tier 2 (Haiku):** Scan the completed scene transcript. Identify every entity that was meaningfully involved (not just mentioned in passing). Append a one-line changelog entry to each entity's file, scene-referenced and wikilinked.

This keeps changelogs current without the DM having to manually update every file after every scene. The DM can always edit or amend changelogs directly if the automated entry is wrong or incomplete.
