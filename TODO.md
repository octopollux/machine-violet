# TODO

When creating a plan to do any of these items, include a step to update this TODO file!

## Refactoring


## Bugs


## Features


## Upcoming Major Features (for architectural awareness)
- Light up multiplayer support: Setup agent sets up more than one player character, addressing one human player at a time; UI updates as specified in design docs. We will need support for state describing which players are actually in the game, out of all known players; this probably belongs in session state. OOC agent can handle chargen.
- Game systems: PDF/document ingest, DM context, resolution subagents, possible system-specific prompt and tool variants
- Choose a minimum terminal size so we can start making some UI assumptions
- UI rework: Pretty ASCII-Art-based UI frames, a more visually defined "player pane" below the conversation view with modeline, input line, etc
- Game export + import, including a mode tha exports only the "game" and universe without the narrative (does not include game system documents)
- Game Journal: A player-facing compendium of characters, places, storyline, lore, and objectives, implemented as a navigable tree in a center modal. We can guarantee the player-facing part by using a subagent with access to only the player-facing game transcript to populate and update it. The DM has access to this dataset as a useful reference for "what the player knows".