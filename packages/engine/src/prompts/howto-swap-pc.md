# How to swap the player character

This is a procedure, not an action. It explains how to hand player control from
the current PC to a different character — either an existing one already in the
story (an NPC, an ally) or a brand-new character. Follow every step: a PC swap
touches several independent pieces of state, and skipping one leaves the game
half-swapped (the classic failure is the roster reverting to the old PC on the
next load).

## The model

A "PC" is just a roster slot in `config.json` → `players[]` whose `character`
field names a character. The active slot is chosen by `activePlayerIndex`. The
character's *sheet* (a stable UID in campaign knowledge), the *party* (`Party/The Party`),
the top-frame *resources*, the *modeline*, and the *theme color* all key off
that character's name. A swap means pointing the slot at a new character **and**
bringing all of those satellites along.

`swap_pc` is the only tool that edits the roster, and it is the only step that
persists `config.json`. Everything else is ordinary sheet/UI editing.

## Steps

1. **Confirm the intent.** Who is retiring, and who takes over? Is the incoming
   character brand-new, or already an entity in the campaign? If the player is
   present, make sure this is what they want — a swap is a big narrative move.

2. **Read and prepare the incoming character's PC sheet.** Use `knowledge`
   (`action: "read"`, `handle: "<UID or known name>"`) to inspect an existing
   character. Record the promotion through `scribe`, tagged `player-facing`:
   identify the character UID and set typed fields `type: "PC"`, `player` to
   the player name, `display_resources` to the display keys, and `theme_color`.
   Include the stats, skills, abilities, and promotion history. For a new
   character, ask the Scribe to create the full sheet in `Characters` first;
   read back its committed UID before referencing it elsewhere.

3. **Demote the outgoing PC.** Send a `scribe` update identifying their UID,
   setting `type: "character"` and `player: null`, and recording retirement
   from player control. Update relationships that described them as the PC.
   Preserve the character and their existing facts; they may recur in the world.

4. **Swap the roster pointer.** Call `swap_pc({ character: "<new PC>",
   replaces: "<old PC>", color: "#hex" })`. Omit `replaces` to hand off the
   currently-active slot. This reassigns the slot, sets the active PC, and
   persists `config.json` — this is the step that makes the swap survive a
   reload. (`switch_player` will NOT work here: it only passes the turn between
   characters already in the roster and rejects an unknown name.)

5. **Update the party roster.** Read `Party/The Party` through `knowledge`.
   Ask `scribe` to replace the outgoing PC's reference in its typed `members`
   array with `{ "$ref": "<incoming UID>" }`, preserving the other members.
   Record the old PC's retirement separately if useful.

6. **Bring the top-frame resources across.**
   - `set_display_resources({ character: "<new PC>", resources: [...] })` — which
     keys show (e.g. `["HP", "Memory"]`).
   - `set_resource_values({ character: "<new PC>", values: { "HP": "9/9", ... } })`
     — their current values.
   The old PC's resource entries can be left or cleared; they no longer display
   once the slot points elsewhere.

7. **Set the new PC's modeline.** `update_modeline({ character: "<new PC>",
   text: "..." })` so the status line reflects who you're now playing.

8. **Re-theme to the new PC (optional but expected).** If the new PC has a
   distinct theme color, `style_scene({ key_color: "#hex" })` (or a mood
   `description`) so the UI matches.

9. **Handle combat if active.** If a fight is in progress, the initiative order
   still lists the old PC as a combatant. End or rebuild combat so turn order
   tracks the new PC; don't leave a retired PC holding initiative.

## Notes

- The character's typed `type` field records the role (`PC`, `NPC`, or
  `character`). The functional roster remains `config.players`, changed by
  `swap_pc`. Keep the role and roster consistent.
- Use `knowledge` or `show_character_sheet` to inspect committed sheets after
  the swap. A session-start prompt copy may still describe the outgoing PC;
  committed knowledge and the persisted roster govern future loads.
- Complete the sheet and Party updates with `scribe` and call `swap_pc` in
  one pass. Sheet updates alone do not reassign player control; a roster swap
  without the sheet work leaves the incoming PC without their mechanics.
