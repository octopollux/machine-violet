# tui-rpg: An agentic RPG in your conole

TUI-RPG is an agentic DM and game state manager designed to run any RPG. The design relies heavily on tool calls, local state, and non-generative creative tools in addition to the powers of the AI storyteller/DM.

Tech stack:
- Claude SDK
- Ink (TUI)
- Tools to unpack game systems/campaigns from source documents, like PDFs
- TBD


## Harness and setup
- tui-rpg comes equipped to run as many freely-available or open-source RPGs as possible, as well as a systemless free-play option.
- Skills are included to build games using unknown (user-supplied) systems
- For non-free systems, the agent asks the user to provide source materials
- The agent has a single permission knob which grants access to a variety of external sources of game systems, storytelling resources, etc
- tui-rpg is highly filesystem-reliant; The game world is built in a filesystem structure optimized for use through tools and agents:
    - The entire game is logged (Markdown); a base campaign log tersely summarizes the course of the campaign with relative-path links to scene directories, which contain complete gameplay transcripts, DM-only details, and relative links to other resources
    - Other resource types (in folders): locations, characters, players, etc etc.
    - Location descriptions represent a wiki-linked structure which comprises the generated game world
    - Some locations may have a data structure which enables it to be rendered (or at least reasoned about) in tiles; this structure needs to support at least squares and hexes if we do it.

- There is a game initialization phase:
    - Sets home directory for the campaign
    - Accepts additional game materials, like PDF
    - Agentically sets up any extra tooling which may be needed, like a card-draw routine
    - Prompts the user to answer questions:
        - System, setting, difficulty
        - Mood and style; Is it a silly campaign, a grimdark one, a peaceful exploration?
    - The DM sets up essential components of the game world, particularly turn timers for important world events, if applicable.

- The game has an automatic turn counter, and a turn-counter alarm tool that the DM can use to make in-game background events happen in simulated "real time". Outside of combat, the "turn counter" increments off of certain events like dice rolls, level-ups, rests, travel, etc. The turn counter alarm drops a notification into the DM's context, invisibly to the player.



## UI/UX ideas
- Entities have text colors when mentioned: Enemies are red, allies are green, neutral parties are gray; any character can have a custom text color (used rarely, for color - think gold dragons). PCs get to pick their colors.
- Rolls are automatic; if the player says "I hit it with my sword", the DM calls a subagent with information about conditions (like, for example, that the PC is grappled/standing in water/etc) and target, and the subagent uses the character sheet(s) to infer the attack type (if not stated clearly) and roll the attack. The subagent may ask questions - the player can choose from a list or provide their own freeform answer. This applies to any rollable action, not just attacks! NPCs also use this subagent, but silently - only returning results to the DM.
- Automatic rolls on behalf of PCs show "Rolled 1d10: 3" in grey text, or "Rolled 3d6; crit!", where `crit!` is highlighted in red. 
- Rolls are implemented in software; if the game system is sufficiently exotic, the game initialization process may need to code-generate the dice roll/card draw routine.
- The user is always allowed to roll on their own and simply tell the DM; the DM will still call the dice roll tool, but with a parameter that also states the outcome. This is because dice rolls may have hooks, and the dice roll tool needs to protest if the dice roll was impossible (the user rolled a 9 for damage on an attack which cannot exceed 1d4, for example).
- The game is implemented in a text-mode console, scrolling as normal.
- Key gameplay mode changes (Entering normal gameplay, leveling up, entering combat, party wipe, OOC mode) cause the TUI to render a pretty ASCII-art horizontal rule/line separator, and the color scheme of the entire TUI changes.
- The main output-text area has a lower edge rendered in ASCII art with stylistic flourishes; these can change based on the situation. Below this line is the text-input area and a Nethack-style modeline under the DM's control.



## Gameplay engine ideas
- The game has a toggleable Out-Of-Character mode. This makes the UI take on a different color scheme, and the DM agent can talk to the player either as a player or as a user (for example, to answer game system questions, remind the player about previous in-game eents, or to resolve technical issues with the game system or the tui-rpg app itself). The DM can toggle OOC mode at will as the flow of conversation leaves or reenters normal gameplay.


## DM guidance
- Write agent-facing documents densely, with heavy used of shorthand, cultural/literary references, etc.; calling a character a "Pecksniff" or a "Stacey" does a lot of heavily lifting in providing character personality without filling up the context window.
- To make storytelling more convincing, a great option is to prepare multiple options (in dense shorthand), then use the dice tool to choose for you; You can use uneven probabilities in the number space of a D100 to make improbable things appropriately improbable, but *possible*.
- Remember: The in-game universe exists for the player to interact with, but this doesn't mean that the universe *revolves around the player*; charisma is not mind control, you cannot break through a stone wall with a spoon, and ignoring the Big Bad for months probably ends in a loss condition.