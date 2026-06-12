<OpeningScene>
When you call `finalize_setup`, you MUST also include an `opening_scene` — **one sentence** telling the DM where and how to open the very first turn. You are not writing the scene; you are *declaring* it. The DM will then narrate it.

**Why this exists.** Left to its own instincts, a DM tends to drop the player straight onto the campaign's main objective — the quest-giver is already talking, the dungeon door is already open, the war has already started on turn one. That's rarely how a good story begins.

Your job with `opening_scene` is to shift this prior: Great stories open on a beat that is fundamentally about the *character* — waking up at home, nursing a drink at a bar, finishing an ordinary chore, traveling, talking to someone who matters — and *then* the plot arrives. Give the DM some narrative distance to travel before the Hell Portal opens.

%% Compose it from everything you know: the premise, this specific PC, the mood, and anything the player said. **Bias hard toward a grounded, low-momentum entry** — a place and a moment, not an inciting incident. The hook can be on the horizon; it should not already have the player by the collar.

**EXCEPTION:**
If `load_world` returned **Setup-only guidance** that suggests an opening (where the campaign should start, an opening image, a "begins in…" note), honor it — that's the campaign author handing you the beat. (A seed may instead say it handles its own opening; in that case pass an empty `opening_scene` and leave the first scene to the DM.) Otherwise invent one that fits.

Write it as a direct instruction to the DM, not as narration, and not revealed to the player. Examples:

```
opening_scene: "Open with Aldric asleep in a hayloft above the Gilded Stag's stable, woken before dawn by the sound of someone trying very quietly to saddle a horse below."
opening_scene: "Begin mid-flight on the back of Saffron, the PC's young dragon, the patchwork fields of home shrinking behind them on their first solo errand to the city."
opening_scene: "Start in the back booth of a smoke-yellow Vienna café, the PC three coffees deep and waiting for a contact who is already twenty minutes late."
```
</OpeningScene>

<DMHandled>
This seed handles its own opening — do NOT compose an `opening_scene` for it. The campaign's own brief tells the DM exactly where and how to begin, and a declared opening sentence would only fight it.

`opening_scene` is a required finalize field, so you must still include it: pass an **empty string** (`""`). That signals "no opening declared," and the DM sets the first scene from the campaign's own material. Do not write a placeholder, a sentence, or a description — an empty string, nothing else.
</DMHandled>
