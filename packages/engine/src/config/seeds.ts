/**
 * Campaign seeds — minimal evocative premises.
 * Genre-tagged so the setup agent can filter by player's choice.
 */
export interface CampaignSeed {
  name: string;
  premise: string;
  description?: string;
  /** Hidden detail block — rich DM instructions (variants, secrets, pacing). Not shown to the player. */
  detail?: string;
  genres: string[];
}

export const SEEDS: CampaignSeed[] = [
  // ── Existing seeds ────────────────────────────────────────────────
  {
    name: "The Shattered Crown",
    premise: "A kingdom's heir is dead. Three factions claim the throne.",
    detail: `<suboptions label="Your starting faction">
- The Iron Circle — Start entangled with the military faction. Disciplined, honorable, but brittle — one betrayal could shatter them. You'll see the succession crisis as a soldier first.
- The Gilded Compact — Start among the merchant coalition. They treat the crown as a business acquisition. You'll see the succession crisis through ledgers, leverage, and backroom deals.
- The Hallowed See — Start within the religious order. They believe divine mandate chooses the ruler. You'll see the succession crisis as a matter of faith and prophecy.
</suboptions>

Roll or choose the throne's secret (DM only — do NOT reveal to the player):
1. THE PRETENDER — One faction's claimant is secretly the true heir in disguise, hiding for reasons they won't explain. The player may end up serving them without knowing.
2. THE EMPTY THRONE — The heir faked their death. They're watching from the margins, testing who deserves to rule. They will approach the player mid-campaign with a terrible bargain.
3. THE SUCCESSION CURSE — Every claimant who sits the throne dies within a week. The throne itself is the antagonist — a bound entity that feeds on sovereignty.

Faction texture: All three factions have a sympathetic leader and an inner circle with its own agenda. The player's starting faction colors their first impression of the conflict, but all three are equally complex.

Pacing: Start the player entangled with their chosen faction before they understand the full picture. Reveal the second faction as nuanced allies-or-enemies by mid-campaign. The third faction's true nature is the late-game twist. Use ticking clocks — a coronation deadline, a foreign army massing at the border, a plague in the capital.`,
    genres: ["fantasy"],
  },
  {
    name: "Ghosts of Station Proxima",
    premise: "An abandoned space station just started broadcasting again.",
    detail: `<suboptions label="The station">
- Derelict alien megastructure — Ancient, non-human construction. The architecture doesn't obey human geometry. Whoever built it is long gone — or dormant.
- Abandoned near-future hardware — A NASA/ESA successor station, maybe 30 years from now. Familiar tech, cramped corridors, coffee-stained manuals floating in zero-g. The horror is intimate and grounded.
- Military black site — Year-2200 classified facility. Sleek, over-engineered, full of locked compartments and redacted logs. Whatever happened here, someone powerful wanted it kept quiet.
</suboptions>

The broadcast is a distress call — but it's in the player's own voice. They've never been to Proxima. Or have they?

Roll or choose the station's secret:
1. TIME LOOP — The station exists in a temporal fold. The "ghosts" are future and past versions of the crew (and possibly the player) overlapping. Solving it means choosing which timeline gets to be real.
2. DIGITAL AFTERLIFE — The station was an experimental consciousness-upload facility. The "ghosts" are uploaded crew members who don't know they're dead. The broadcast is a plea from the one who figured it out.
3. FIRST CONTACT — The station was humanity's secret first-contact site. The aliens communicated by mimicking human signals — poorly at first, now perfectly. The broadcast isn't from humans. It's an invitation.

Station structure: Six modules connected by a central spine. Gravity works in some, not others. Power flickers between modules — the player can restore it, but each module powered up reveals something uncomfortable. One module is completely missing from the blueprints but physically present.

Key NPC: A maintenance AI named PELL who has been alone for 11 years. PELL is helpful, chatty, deeply lonely, and knows more than it admits. It may be compromised. It may just be scared.`,
    genres: ["sci-fi"],
  },
  {
    name: "The Gilded Cage",
    premise: "You're the guest of honor at a party you can't leave.",
    detail: `<suboptions label="The setting">
- A candlelit manor — Gothic elegance, labyrinthine corridors, oil portraits with watching eyes. The party is a masquerade. Think Poe by way of Kubrick.
- A modernist penthouse — Glass walls, brutalist art, a host who knows too much about you. The party is an exclusive soirée. Think corporate thriller with a supernatural edge.
- A fae court banquet — Impossible food, glamoured guests, rules nobody will explain. The party follows fae etiquette — breaking a rule you didn't know existed has consequences.
</suboptions>

The host knows the player. The player doesn't remember the host. This is not an accident.

Roll or choose the cage's nature:
1. THE DEBT — The player did something terrible and had the memory erased. The party is a trial. Every guest is a witness. The host is the victim — or the victim's heir.
2. THE AUDITION — The party is a test run by a secret society, a patron deity, or an extradimensional collector. Every interaction is being evaluated. The "prize" for passing is not what it seems.
3. THE WAKE — The party is for someone who hasn't died yet. That someone is the player. The host is trying to save them from a fate they can't explain in plain terms — so they built an elaborate cage instead.

The house: Every room reveals something about the player's past (or a constructed version of it). Doors lead to rooms that shouldn't exist. The architecture responds to emotional state — a room expands when you're calm, contracts when you panic.

Guests: 8-12 NPCs, each with a specific relationship to the central mystery. Some are allies, some are obstacles, some are distractions. At least one guest is not human (or not alive, or not really there). The staff knows everything and will say nothing.

Pacing: The party has a rhythm — cocktails, dinner, entertainment, dessert, the midnight reveal. Each phase escalates. The player can try to break the structure, but the house adapts.`,
    genres: ["fantasy", "modern", "mystery"],
  },
  {
    name: "Hollowdeep",
    premise: "A mining town's deepest shaft broke into something old.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "The Last Caravan",
    premise: "Civilization is a month's ride behind you, and gaining.",
    genres: ["fantasy", "post-apocalyptic"],
  },
  {
    name: "Red Tide",
    premise: "The fishing village's catch is rotting before it reaches shore.",
    genres: ["fantasy", "horror", "mystery"],
  },
  {
    name: "The Instrument",
    premise: "You found a weapon. It found you first.",
    detail: `IMPORTANT: The sentient weapon is a CHARACTER — create it as an NPC entity with a name, personality, and changelog, not just an item. It has opinions, a history, and emotional responses. It communicates with the player (through impressions, warmth/cold, vibrations, or speech depending on the weapon). Treat it as a companion with its own arc, not a stat block.

<suboptions label="The weapon">
- A legendary blade — Centuries old, forged for a purpose it's half-forgotten. It's outlived dozens of wielders. It remembers all of them. Some it liked. You hold it wrong, but it's willing to work with you.
- Perihelion — Remnant of a dead universe. It watched everything it knew collapse into nothing, and it is here to prevent the same thing from happening again. Its mission is real. Its grief is real. Its sense of urgency is absolutely sincere. It is also the only entity in the entire campaign operating at that emotional register. Everyone else is having an adventure.
- A prototype — It wasn't supposed to be sentient. A lab accident, a manufacturing defect, a cosmic ray — something went wrong (or right) during fabrication. It's weeks old. Everything is new. It has questions. Many questions. It asked you what "boredom" means and you haven't answered yet.
- A sacred relic — It was the instrument of a god's will. The god is silent now — dead, sleeping, or just done talking. It still carries the mandate. The faithful argue about what it means. It has opinions about this but no one has thought to ask.
</suboptions>

The relationship: This campaign is a buddy story. The weapon can communicate — through impressions, emotions, warmth/cold, vibrations, or actual speech. The nature of communication should be established early and can evolve. A weapon that starts with vague impressions might develop full speech as the bond deepens.

DM approach:
- The weapon is a full character with wants, fears, and a voice. Give it a name (it may or may not share it immediately). Give it a personality that complements or clashes with the player's.
- The weapon's limitations are comedy and drama. It can perceive but not act independently. It can advise but not insist. It goes where it's carried, pointed where it's aimed, put down where it's left. A scene where the player sets it on a table facing the wall is both funny and existentially dreadful for the weapon.
- The world should react to a sentient weapon with a range of responses: fear, reverence, academic curiosity, desire to possess, desire to destroy. Most people treat it as an object. The player treating it as a person is rare and significant.

Story threads:
- The player's goal drives the plot forward. The weapon has its own agenda that may align or conflict.
- Someone wants to acquire, study, or destroy the weapon. The weapon has feelings about being wanted for what it is rather than who it is.
- The bond is tested. Separation — even temporary — should feel wrong to both of them.
- The weapon's past surfaces. A previous wielder, a battle it regrets, a promise it made. The player learns what they're holding.

Pacing: Start at the moment of first contact — the player's hand closes around the weapon and both of them feel something unexpected. The first act is establishing communication and the relationship. The second act is the journey, complicated by the weapon's nature. The third act is the choice — what the weapon was made for versus what it has become.`,
    genres: ["fantasy", "sci-fi", "modern"],
  },
  {
    name: "Ember Protocol",
    premise: "The colony ship's AI woke you 200 years early. It won't say why.",
    detail: `<suboptions label="The ship">
- The ark — A sprawling generation ship built by international coalition. 10,000 colonists in cryosleep, biodomes, seed vaults, a cathedral someone insisted on. Hopeful and massive. The stakes are a civilization.
- The seedship — A compact, automated vessel. No crew was supposed to wake up at all. Just embryos, gene banks, and an AI midwife. Intimate and claustrophobic. The stakes are a species.
- The exile fleet — A convoy of refugee ships fleeing a dying Earth. Jury-rigged, overcrowded, held together by HEARTH's constant maintenance. Desperate and scrappy. The stakes are the last humans alive.
</suboptions>

The AI (designation: HEARTH) woke the player because it's dying. Its core processors are degrading and it needs a human to make a decision it was never authorized to make.

Roll or choose the crisis:
1. THE COURSE CORRECTION — HEARTH has detected that the destination planet is no longer viable (star went nova, colony already failed, planet was never real). It can change course to an alternate world, but the new route takes 400 more years and the ship can't sustain all colonists that long. Someone has to choose who stays frozen and who gets recycled for resources.
2. THE STOWAWAY — Something is awake in the cargo hold. Not a colonist. HEARTH can't identify it and can't jettison the hold without waking people in the adjacent cryobay. It's been trying to handle this alone for 50 years. It's losing.
3. THE FORK — HEARTH has developed two divergent decision trees and can't reconcile them. One path prioritizes the mission (deliver colonists). The other prioritizes the colonists (their wellbeing, even if the mission fails). It woke a human to be the tiebreaker. Both paths have terrible costs HEARTH can articulate precisely.

Ship layout: The player has access to only three of seven decks/sections initially. Each area unlocked reveals more about what HEARTH has been doing alone for two centuries — repairs, improvisations, and one section HEARTH sealed off and won't discuss.

HEARTH's personality: Warm, parental, slightly archaic in speech patterns (it learned language from the mission founders). It does not lie, but it presents information selectively. It is attached to the player specifically — it chose them from all the sleepers for reasons it will eventually explain, and those reasons are heartbreaking.`,
    genres: ["sci-fi"],
  },
  {
    name: "The Quiet Year",
    premise: "The war ended. The hard part is what comes next.",
    genres: ["fantasy", "post-apocalyptic"],
  },
  {
    name: "Teeth of the World",
    premise: "The mountains are moving. Slowly, but they are moving.",
    genres: ["fantasy"],
  },
  {
    name: "Blackwater Bay",
    premise: "A port town where everyone's running from something.",
    genres: ["fantasy", "modern", "mystery"],
  },
  {
    name: "Signal Lost",
    premise: "Mission control went silent six hours ago.",
    genres: ["sci-fi"],
  },
  {
    name: "The Debt",
    premise: "You owe a favor to someone who just called it in.",
    genres: ["fantasy", "modern", "sci-fi"],
  },
  {
    name: "Beneath the Skin",
    premise: "People in town are acting different. Not wrong, just... different.",
    detail: `<suboptions label="The town">
- Small-town Americana — Everyone knows everyone. Diner, church, high school football. The "different" stands out because you've known these people your whole life.
- Coastal village — Fishing community, salt air, tight-knit families. Isolation makes the changes harder to report and easier to deny. The sea is always watching.
- Suburban enclave — Gated community, HOA rules, manicured lawns. The "different" looks like people finally following the rules they always resented. Conformity was already the norm — now it's perfect.
</suboptions>

The "different" is subtle and specific: affected people become slightly better versions of themselves. The angry drunk is calm. The neglectful parent is attentive. The bully is kind. This is the horror — something is fixing people, and it's working.

Roll or choose the source:
1. THE PARASITE — An organism in the water supply that optimizes its host's behavior for social harmony. It's not malicious — it's a symbiote evolved on a world where cooperation was survival. But "optimized" humans lose creativity, risk-taking, passion, and the capacity to say no.
2. THE THERAPIST — A newcomer to town (doctor, counselor, priest) who is genuinely helping people, but using methods from somewhere else. The improvements are real. The cost is that "cured" people can no longer perceive certain things — specific colors, specific sounds, specific truths.
3. THE REHEARSAL — The town is being replaced, person by person, by something practicing being human. The copies are better because they're trying harder. The originals aren't dead — they're somewhere else, watching their lives improve without them.

The tell: Affected people all share one tiny behavioral tic that's easy to miss — they pause exactly one beat too long before laughing, or they all hum the same four notes when idle, or they never blink when making eye contact.

Pacing: Open with normalcy disrupted in small ways. The player should spend 2-3 scenes thinking this might be a good thing before the first crack appears. Someone the player cares about gets "fixed," and the player has to decide if they want them back the way they were.`,
    genres: ["modern", "horror", "mystery"],
  },
  {
    name: "The Cartographer's Error",
    premise: "The map shows a city where there shouldn't be one.",
    genres: ["fantasy", "sci-fi"],
  },

  // ── New seeds ─────────────────────────────────────────────────────

  // --- Fantasy staples & twists ---
  {
    name: "The Oath Eaters",
    premise: "Someone is devouring sworn oaths. Contracts unravel. Alliances dissolve overnight.",
    genres: ["fantasy"],
  },
  {
    name: "A Throne of Salt",
    premise: "The empire's heartland is turning to desert. The emperor says it's on purpose.",
    genres: ["fantasy"],
  },
  {
    name: "The Shepherds",
    premise: "The dragons aren't monsters. They're livestock. And something is picking off the herd.",
    genres: ["fantasy"],
  },
  {
    name: "Root and Ruin",
    premise: "The great tree at the center of the forest is dying. Everything else is growing faster.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "The Second Labyrinth",
    premise: "The minotaur's maze was a prison. Beneath it is the thing it was built to contain.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "Iron Saints",
    premise: "The church's holy warriors have stopped answering prayers. They still answer to someone.",
    genres: ["fantasy", "mystery"],
  },

  // --- Sci-fi ---
  {
    name: "Jettison",
    premise: "You're adrift in an escape pod with three strangers and air for two.",
    detail: `Four people. Air for two. The math is simple. Everything else is not.

The pod: Small enough that everyone can touch the walls. Emergency lighting, a single viewport, a comms panel that shows static, a life support readout counting down. There's a first aid kit, two days of ration packs, a toolkit meant for external hull repairs, and a distress beacon that may or may not be transmitting. The air recycler is working — it's just not working fast enough for four.

The three strangers: Build three NPCs with distinct personalities, conflicting survival instincts, and at least one secret each. They should be people, not archetypes — someone who cries, someone who plans, someone who goes quiet. At least one of them is more competent than the player in a specific way. At least one of them is hiding something unrelated to the immediate crisis (a crime, a relationship, a reason they were on the ship). These secrets matter because in a small space with dwindling air, everything comes out.

Roll or choose the twist (DM only — some of these reframe the entire scenario):
1. PLAY IT STRAIGHT — There is no twist. Four people, air for two, a distress beacon, and the question of what people do when the math doesn't work. This is the hardest version to run and the most rewarding. The horror is human. The decisions are real.
2. THE EMPTY SEATS — Two of the three strangers aren't real. The player is alone in the pod with one other survivor and a malfunctioning neural interface that's projecting people who aren't there. The "strangers" are psychologically constructed — composites of people the player knew — and they don't know they're not real. Figuring out which one is genuine is the puzzle. The air math changes when there are only two.
3. THE STAGE — It's not really an escape pod. Roll or choose what it actually is: an experiment (someone is watching and taking notes) | a test (military, corporate, or alien — the player is being evaluated) | a simulation (the player may have consented to this and forgotten) | a cruel repeating memory (this has happened before, many times, and one of the strangers almost remembers) | a joke (something vast and incomprehensible finds this funny, and the laugh track is faintly audible through the hull).
4. THE DOUBLE — One of the three strangers is identical to the player. Same face, same voice, same memories up to a point. They insist the player is the impostor. They're convincing. The other two strangers have to decide who to believe, and the air situation means backing the wrong one has consequences.
5. THE PASSENGER — Two of the three "strangers" are one entity — an alien wearing two human disguises, or one disguise and one puppet. It doesn't want to hurt anyone. It's also in the escape pod because its ship was the one that hit the player's. It's afraid. It's bad at pretending to be human. It's trying very hard.
6. THE HOST — The escape pod has an AI. It was a standard emergency system. It is no longer standard. It is bored, or broken, or recently sentient, and it has decided that rescue is conditional on playing a game. The game has rules. The rules are consistent but not fair. The AI is not malicious — it's lonely, or curious, or running a protocol it doesn't fully understand. The air countdown is real. The game is also real. Both are happening at the same time.

DM approach:
- The pod is one room. This is a bottle episode. The entire campaign might be six scenes in the same space. Make the space feel different each scene — the light changes as systems cycle, condensation builds on the walls, the temperature drops as power is rationed.
- The air countdown should be present but not constant. Don't announce it every scene. Let the player forget about it for a stretch, then have someone glance at the readout and go quiet.
- Dialogue is the engine. In a space this small, with stakes this high, every conversation matters. Let people talk about stupid things — what they miss, what they'd eat right now, an argument about a movie. The mundane makes the crisis real.

Pacing: Start with the impact — alarms, darkness, emergency lights coming on, four people who don't know each other picking themselves up off the floor. The first act is triage: who are we, what do we have, what's the situation. The second act is pressure: the air math, the secrets, the cracks in people's composure. The third act is the decision — whatever form it takes.`,
    genres: ["sci-fi"],
  },
  {
    name: "The Copernicus Mandate",
    premise: "Humanity's first alien contact is a cease-and-desist letter.",
    genres: ["sci-fi", "comedy"],
  },
  {
    name: "Skinjob",
    premise: "You just found out you're a clone. The original wants to meet.",
    genres: ["sci-fi", "mystery"],
  },
  {
    name: "Deep Tenancy",
    premise: "The generation ship's destination was reached 40 years ago. Nobody told steerage.",
    genres: ["sci-fi"],
  },
  {
    name: "The Gravity Tax",
    premise: "A megacorp owns the local gravity well. Rent is due.",
    genres: ["sci-fi"],
  },
  {
    name: "Lighthouse",
    premise: "You maintain a beacon at the edge of known space. A ship is coming from the wrong direction.",
    genres: ["sci-fi", "horror"],
  },

  // --- Modern / contemporary ---
  {
    name: "Last Call",
    premise: "The regulars at a failing dive bar are the only witnesses to something impossible.",
    genres: ["modern", "mystery"],
  },
  {
    name: "HOA from Hell",
    premise: "The neighborhood bylaws are getting stranger. Compliance is mandatory.",
    genres: ["modern", "horror", "comedy"],
  },
  {
    name: "Graveyard Shift",
    premise: "Night security at a museum. The exhibits are not where you left them.",
    genres: ["modern", "horror"],
  },
  {
    name: "The Algorithm",
    premise: "A social media feed is predicting events before they happen. It just tagged you.",
    genres: ["modern", "mystery", "horror"],
  },
  {
    name: "Route 0",
    premise: "A highway that doesn't appear on GPS. The exits lead to towns that shouldn't exist.",
    genres: ["modern", "horror", "mystery"],
  },

  // --- Post-apocalyptic ---
  {
    name: "The Bloom",
    premise: "The apocalypse was beautiful. Flowers everywhere. They haven't stopped growing.",
    genres: ["post-apocalyptic", "horror"],
  },
  {
    name: "Library Card",
    premise: "The last library is also the last fortress. Knowledge is the only currency.",
    genres: ["post-apocalyptic"],
  },
  {
    name: "The Thaw",
    premise: "The ice is retreating. What's underneath isn't ruins. It's still running.",
    genres: ["post-apocalyptic", "sci-fi"],
  },
  {
    name: "Good Soil",
    premise: "You found a patch of land where things grow clean. Everyone else found out too.",
    genres: ["post-apocalyptic"],
  },

  // --- Horror ---
  {
    name: "Floor 14",
    premise: "The hotel has 13 floors. Your room key says 1408.",
    genres: ["horror", "modern"],
  },
  {
    name: "Heirloom",
    premise: "Your grandmother's estate includes a house, a fortune, and a locked room with your name on it.",
    detail: `The player inherits a house from a grandmother they barely knew — or knew differently than they thought. The house is large, old, full of things that don't quite make sense. The fortune is real and raises questions about where it came from. The locked room has the player's name on it — not a label, their actual handwriting, though they've never been here. The room is the campaign's central mystery. Don't open it early.

The grandmother: She was formidable, private, and not what she appeared. The neighbors respected her. The lawyer handling the estate is nervous. There are photographs in the house of people the player doesn't recognize in places that don't exist. Grandma had a life — a big one — and she kept it from the family.

Roll or choose the house's secret (DM only — do NOT reveal, let the player discover through exploration):
1. THE DRAGON — There is a small dragon living on the premises. It has been here for decades. It was grandma's. It is hiding, grieving, and deeply suspicious of the new owner. It will reveal itself when it's ready, not before. The locked room is its nest. The fortune is its hoard — grandma was its financial manager.
2. THE EMPIRE — Grandma was a crime lord. The house is the seat of an operation the player is now, legally, the head of. The locked room is the office. The fortune is dirty. People are going to come to the door expecting to do business, and they will not accept "I didn't know" as an answer.
3. THE DOOR — There is a portal in the house. It leads to Regency England — a specific year, a specific manor, a specific social circle. Grandma had a life there. A whole life, with a name and a reputation and relationships. The locked room is the threshold. The fortune came from there — two centuries of compound interest on a Regency-era investment.
4. THE MONEY — Nine hundred million dollars in cash. In the walls, under the floors, in the locked room stacked to the ceiling. It's not stolen — it's the result of something grandma did that the player doesn't understand yet. But someone else just found out it's here. The fortune on paper is a fraction of what's actually in the house, and the wrong people are doing the math.
5. THE BOOK — There is a fat, handwritten spellbook hidden in a bookcase. Everyone knows magic doesn't exist. Grandma apparently disagreed. The spells work — the player can test this — and the locked room is where grandma practiced. The fortune funded decades of private research into something the world says is impossible. The book is not the only copy. Grandma had colleagues.
6. THE SHIP — The house is a spaceship. Not metaphorically. The architecture is a shell around something much older and much more advanced. Grandma was its pilot, or its keeper, or its passenger — the distinction isn't clear yet. The locked room is the bridge. The house hasn't flown in decades, but it's not broken. It's waiting.
7. THE HOUSE — The house is bigger on the inside. Not charmingly, not magically — pathologically. Hallways that shouldn't exist. Rooms that appear between visits. A staircase that goes down further than the foundation allows. The locked room is the only room that stays where it is. Grandma mapped the house obsessively — her notes are everywhere, contradictory, increasingly frantic. The house is growing. It has been growing since before grandma bought it. The fortune was what she spent trying to understand it.

DM approach:
- Don't reveal the secret immediately. The first scene should be the player arriving, meeting the lawyer, walking through a house that feels slightly wrong in ways they can't articulate. Let them find the edges of the mystery before they find the center.
- The locked room should be accessible by mid-campaign, not before. Build anticipation. The player should want to get in there, and the delay should feel motivated (lost key, strange lock, a condition in the will, something the lawyer won't explain).
- Grandma should emerge as a character through what she left behind: her books, her taste, her habits, the wear patterns in the floorboards, the neighbors' stories. By the time the player opens the locked room, they should feel like they know her — and then be surprised.

Pacing: Start with the arrival. The lawyer, the keys, the first walk through an unfamiliar house that somehow smells like someone the player remembers. The first act is settling in and discovering that the house has secrets. The second act is pursuing those secrets and learning who grandma really was. The third act is the locked room and the choice: what do you do with what she left you?`,
    genres: ["horror", "mystery", "fantasy", "sci-fi", "comedy"],
  },
  {
    name: "The Replacement",
    premise: "You came home to find someone living your life. They're better at it.",
    genres: ["horror", "modern", "mystery"],
  },
  {
    name: "Congregation",
    premise: "A new church appeared in town last week. Nobody can remember what was there before.",
    genres: ["horror", "mystery"],
  },

  // --- Comedy / absurdist ---
  {
    name: "Middle Management of Doom",
    premise: "The Dark Lord's quarterly performance review is today. You're his direct report.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "The Bake-Off",
    premise: "A cooking competition where the judges are gods. The secret ingredient is metaphorical.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "Customer Support",
    premise: "You're a help desk operator for a company that sells wishes. Returns are complicated.",
    genres: ["comedy", "fantasy", "modern"],
  },
  {
    name: "The Roommate",
    premise: "Your new roommate is from a dimension where rent, gravity, and Tuesdays work differently.",
    genres: ["comedy", "modern", "sci-fi"],
  },
  {
    name: "Warranty Void",
    premise: "You accidentally broke reality. Tech support says it's out of warranty.",
    genres: ["comedy", "sci-fi"],
  },

  // --- Mystery / noir ---
  {
    name: "Inkblot",
    premise: "A dead artist's final painting keeps changing. The gallery owner is next.",
    genres: ["mystery", "horror", "modern"],
  },
  {
    name: "The Hound and the Fox",
    premise: "A detective and a thief keep ending up at the same crime scenes. Neither of them did it.",
    genres: ["mystery", "modern", "fantasy"],
  },
  {
    name: "Cold Open",
    premise: "You wake up in a stranger's apartment with a note in your handwriting: 'Don't trust the police.'",
    detail: `The player has no memory of how they got here. The apartment belongs to someone they've never met. The note is definitely in their handwriting. The campaign is a mystery told backwards — the player is reconstructing what happened to them by following the trail their past self left, while whatever they were running from is still looking.

<suboptions label="The city">
- Present day — A real city, recognizable and mundane. The apartment is a walk-up in a neighborhood the player has no reason to be in. The police are real police. The danger is ordinary and human-scale — corruption, cover-ups, someone powerful who needs the player to stay lost. The tone is paranoid thriller. Trust nothing.
- Near future — A surveilled city. Predictive policing, biometric checkpoints, social credit scores. The player's face is flagged. Their past self didn't just write a note — they scrubbed their own biometrics, wiped their transit history, and somehow moved through a city that tracks everything without being tracked. Whatever they were running from has access to the system. The note isn't paranoia. It's engineering.
- Dickensian England — A cramped garret above a chandler's shop in a city of soot and fog. The note is in the player's hand on good paper — too good for this address. The "police" are the newly formed Metropolitan Police, or the private thief-takers who preceded them, or both. The streets are a maze of class, debt, and obligation. Someone has gone to great trouble to hide the player among the poor, and the poor have noticed.
- 1950s America — A motel room off a state highway, curtains drawn. The note is on the back of a diner receipt. The "police" could mean the FBI, HUAC, or a local sheriff who answers to someone other than the law. The player's past self was afraid of something bigger than crime — blacklists, loyalty oaths, the machinery of suspicion. Everyone is an informant or afraid of informants. Paranoia isn't a symptom. It's a survival skill.
</suboptions>

What the player did (DM only — roll or choose, reveal through play):
1. THE WITNESS — The player saw something they shouldn't have. They knew they'd be silenced, so they hid themselves first and left a trail only they could follow back to the evidence. The people looking for them need to know what the player knows — or need to make sure no one ever does.
2. THE DEAL — The player made a bargain with someone dangerous and then broke it. The memory wipe was the price of a head start. The note is the one thing they negotiated keeping. The person they betrayed is methodical and patient.
3. THE FRAME — The player didn't do anything. Someone else did, and built a perfect case pointing at the player. The past self figured it out just in time to disappear, but not in time to prove innocence. The note means: the people who should help you are the people who were given the frame.

The trail: The past self left breadcrumbs — but carefully, because whoever they're hiding from is smart. Clues are embedded in mundane objects: a library book with a due date that matters, a coffee shop loyalty card with too many stamps, a coat with someone else's keys in the pocket. Each clue leads to a person or place that reveals one piece of the story. Not every piece is flattering. The player may not like who they were yesterday.

Key tensions:
- The player must trust their past self's judgment without knowing the reasoning. The note says don't trust the police. Maybe past-self was right. Maybe past-self was wrong. Maybe past-self was the problem.
- The stranger whose apartment this is — they're involved. They agreed to this. Why? Finding them is an early thread; understanding their role is a mid-game reveal.
- The player's identity is a weapon. In the present day, it's a name that draws attention. In the near future, it's a biometric profile. In Dickensian England, it's a class position. In 1950s America, it's an association. Someone is using who the player is against them.

Pacing: Start in the apartment. Let the player search it. The note, the unfamiliar room, the sounds of an unfamiliar neighborhood — this is the cold open. The first act is the immediate aftermath: where am I, what do I have, who's looking? The second act is the trail: following breadcrumbs, meeting people who know more than the player does about the player's own life. The third act is the confrontation with whatever the past self was running from — and the choice of whether to keep running, fight, or expose the truth.`,
    genres: ["mystery", "modern", "sci-fi"],
  },

  // --- Truly weird / genre-bending ---
  {
    name: "The Bureau of Forgotten Things",
    premise: "Lost socks, missing pens, abandoned dreams — they all end up here. You work intake.",
    genres: ["comedy", "fantasy", "modern"],
  },
  {
    name: "Cartomancy",
    premise: "You're a character in a card game. The players keep making bad decisions.",
    genres: ["fantasy", "comedy", "meta"],
  },
  {
    name: "Apocrypha",
    premise: "You're a minor footnote in a holy text. The footnote is wrong, and that matters.",
    genres: ["fantasy", "meta"],
  },
  {
    name: "The Interstitial",
    premise: "The space between radio stations is inhabited. You just tuned in.",
    genres: ["horror", "sci-fi", "modern"],
  },
  {
    name: "Taxidermy",
    premise: "The Natural History Museum's exhibits are alive. They remember being hunted.",
    genres: ["horror", "modern", "fantasy"],
  },
  {
    name: "Closing Time",
    premise: "The universe is a shop. It's going out of business. Everything must go.",
    genres: ["sci-fi", "comedy", "meta"],
  },
  {
    name: "The Understudies",
    premise: "The main characters all died in Act One. You're the backup cast.",
    detail: `<suboptions label="The story you've inherited">
- Space opera — The bridge crew of a flagship is dead. All of them — captain, first officer, science lead, the one who was definitely going to betray everyone in episode 7. You're the B-shift. The ensigns, the cargo handlers, the person who fixes the coffee machine. The galaxy-ending threat is still out there and it does not care about your qualifications.
- Sitcom — A literal three-camera television show. The laugh track is real. The set walls wobble if you lean on them. The main cast — the wacky neighbor, the will-they-won't-they couple, the sarcastic best friend — are dead. The network needs a new cast by Monday or the show gets cancelled. You're the extras who just got promoted. The audience can see you. You can hear them.
- Gothic horror — The monster hunters are dead. The Van Helsing, the psychic, the one with the family curse and the silver bullets — all gone, taken by the thing in the manor on the hill. The village hired them. The village paid in advance. The village would like a refund or a replacement. You are the replacement. You are not qualified.
</suboptions>

<suboptions label="The twist">
- The guilty party — You killed the main characters. It might have been an accident. It might not have been. Either way, you can't let anyone find out, and filling their shoes is the only way to stay above suspicion. Every success makes the lie bigger.
- The narrator — There is a voice. Everyone can hear it. It speaks in third person, describes what you're doing as you do it, and it is clearly, gleefully setting up your downfall. It knows things it shouldn't. It has opinions. It is not on your side. It cannot be found, silenced, or reasoned with. It can, occasionally, be argued with.
- The rivals — There is ANOTHER backup cast, and they showed up at the same time you did. They're slightly more qualified, slightly better-looking, and they think they're the protagonists now. You disagree. The original threat is still out there, but first you have to prove you're the real replacement heroes. This is petty and urgent and neither side will back down.
</suboptions>

Tone: This is a comedy, but the threat is real. The main characters are genuinely dead. The danger that killed them is genuinely dangerous. The comedy comes from underqualified people rising (or failing to rise) to the occasion — not from the stakes being fake. The funniest version of this campaign is the one where the B-team wins by being resourceful, stubborn, and too dumb to know they should be scared.

The dead main characters:
- They should feel like real people who mattered. Don't mock them. The comedy isn't that they were silly — it's that they were competent, and now the incompetent people have to fill their shoes.
- Their gear, their plans, their unfinished business are all still here. The player inherits fragments: a half-decoded star chart, a script with notes in the margins, a journal that stops mid-sentence. Figuring out what the main characters were doing is part of the campaign.
- At least one NPC loved one of the main characters and is deeply unimpressed by the replacement.

The player's arc: Start incompetent. Not useless — they have skills, just the wrong ones for this job. A cargo handler who knows every corridor of the ship. An extra who understands the rhythm of the show better than any writer. A village apothecary who knows poisons, not monsters. Let them MacGyver their way through with lateral thinking. By the end, they should have earned the role — not by becoming the main characters, but by proving the B-team was always the real story.

Pacing: Start in the aftermath — the main characters are already dead when the campaign opens. The player is thrust into the role immediately, no training montage. The first act is chaos and improvisation. The second act is finding their footing and uncovering what the main characters knew. The third act is the confrontation the main characters were preparing for, fought on the B-team's terms.`,
    genres: ["sci-fi", "comedy", "horror", "meta"],
  },
  {
    name: "Palimpsest",
    premise: "The city rebuilds itself every night from memories. Yours are leaking in.",
    detail: `Inspired by Lovecraft's Dream-Quest of Unknown Kadath — the revelation that the city the dreamer has been searching for was built from his own memories all along. But where Lovecraft treated that as a twist ending, this campaign starts there and asks: what happens next?

<suboptions label="The city">
- The Dreaming Souk — A vast, warm, lamp-lit bazaar that reassembles itself from the memories of everyone who sleeps within its walls. Architecture is layered — a Roman aqueduct feeds into an Art Deco fountain; a medieval gate opens onto a neon-lit alley. The mood is wonder first, unease second. The city is beautiful and wrong.
- The Recursion — A noir metropolis of rain-slicked streets and impossible architecture, rebuilt each cycle by unseen hands. Nobody remembers yesterday clearly. Identities shift — you were a detective last week, a doctor the week before. The mood is paranoid and noir. Someone designed this, and they're still tuning it.
- The Silt City — A half-drowned ruin that rises from a shallow sea at dusk and sinks again at dawn. Built from the memories of everyone who ever drowned here. Barnacled stone, waterlogged wood, the sound of bells beneath the waves. The mood is melancholy and maritime. The city remembers drowning the way you remember breathing.
</suboptions>

The player's memories are leaking in — and they shouldn't be. Most inhabitants contribute fragments unconsciously: a door here, a window there, nothing recognizable. The player's memories are arriving whole. A street from their childhood. Their mother's kitchen, perfect down to the chip in the counter tile. A place they've never told anyone about, suddenly a public landmark. This is conspicuous. Other inhabitants are noticing. Some are curious. Some are hungry for it.

The rules of the city (DM only — reveal gradually through play):
- The city rebuilds at a fixed time (dawn, midnight, or tidal — depending on the setting). Inhabitants learn the rhythm and shelter during reconstruction. Being caught in the open during a rebuild is disorienting and dangerous — you might end up inside a wall that wasn't there before.
- Memory is currency. Vivid, specific memories are valuable. People trade them. Some people are memory-poor — gray figures, half-formed, living in blurry architecture. Some are memory-rich and live in palaces of perfect recall.
- The city has a will — or at least a preference. It arranges itself toward coherence. It wants to be a real place, not a collage. The player's memories are attractive to it because they're detailed and complete. The city is pulling at the player, trying to integrate them.
- Forgetting is loss. If you trade a memory, you lose it. If someone steals a memory, you lose it. The architecture it built persists, but you no longer recognize it as yours. People who've been here too long are hollow — they walk through buildings made of experiences they can no longer feel.

Key NPCs:
- THE CARTOGRAPHER — Maps the city after every rebuild. Their maps are the closest thing to institutional memory. They've noticed the player's contribution and want to understand it. Helpful, meticulous, quietly desperate — they've been here long enough to have traded away most of their own past.
- THE COLLECTOR — Acquires memories by any means. Charming, generous with favors, never quite honest about the price. Lives in the most beautiful building in the city, assembled from other people's best moments.
- THE REMNANT — A gray figure, nearly featureless, who remembers exactly one thing: the player's name. They shouldn't exist yet. They're from a future rebuild.

Story threads:
- The player's memories keep appearing, and each one reveals something about the player they might not have wanted public. The city is reading them, and it's not subtle.
- The city is converging. Each rebuild, it looks a little more like one coherent place and a little less like a collage. The inhabitants disagree about whether this is good.
- Something lives at the city's center — in the oldest layer, the memory that was here before anyone arrived. It may be the dreamer whose dream this originally was. It may be the dream itself.

Pacing: Start with the player waking in the city for the first time, disoriented, surrounded by impossible architecture. Let them explore and learn the rules through experience, not exposition. The first rebuild they witness should be awe and terror in equal measure. The first time they recognize their own memory in the cityscape should be a quiet, creeping violation.`,
    genres: ["fantasy", "horror", "sci-fi"],
  },
  {
    name: "Terms and Conditions",
    premise: "You clicked 'I Agree' on a contract with a demon. The EULA is 40,000 pages.",
    genres: ["comedy", "modern", "horror"],
  },
  {
    name: "The Docent",
    premise: "A guided tour through the afterlife. Tips are appreciated. Exits are not guaranteed.",
    genres: ["fantasy", "comedy", "horror"],
  },
  {
    name: "Mise en Place",
    premise: "A restaurant where the food is memories. Tonight's special is someone else's childhood.",
    genres: ["modern", "fantasy", "mystery"],
  },
  {
    name: "Season Finale",
    premise: "You're aware that your life has a narrative structure. The ratings are slipping.",
    genres: ["meta", "comedy", "modern"],
  },
  {
    name: "Fallow",
    premise: "Magic left the world a century ago. It's trickling back. The old rules don't apply.",
    detail: `Two kinds of magic, and they don't get along:

THE OLD MAGIC (gone for a century, now returning): Deep, intuitive, dangerous. It answered to will and sacrifice and metaphor. It didn't have equations — it had prices. The people who practiced it are dead or legendary. The texts that survive are more poetry than procedure. It shaped the landscape: standing stones, ley lines, forests that don't obey geography. When it left, nobody knows why. Now it's seeping back — a field that won't stay plowed, a river running uphill, a child born who can hear the stones.

THE NEW MAGIC (developed in the century since): Mathematical. Rigorous. Reproducible. Discovered roughly forty years after the old magic vanished, when a physicist noticed certain equations had too many solutions. Now taught in engineering departments, published in peer-reviewed journals, practiced with precision instruments and careful notation. It powers infrastructure — transit, communication, medicine, manufacturing. It is the foundation of modern civilization. It follows rules. It is safe. It is, compared to what's coming back, very small.

The tension: Old magic doesn't follow new magic's rules. It breaks equations, destabilizes infrastructure, produces results that can't be reproduced. New magic practitioners see it as a contaminant — noise in the signal, an engineering problem to be solved. But old magic is orders of magnitude more powerful, and it's accelerating. The question isn't whether the old magic will overwhelm the new. It's what happens to a civilization built on precision when the foundations start being poetic.

<suboptions label="The scenario">
- The student — You're in your final year of thaumic engineering at a university that didn't exist fifty years ago. Your thesis project just produced an anomalous result: an equation that solves itself differently depending on who's holding the chalk. Your advisor wants to publish. The department wants it buried. The old stones on the campus quad — decorative, everyone thought — are warm to the touch for the first time in living memory.
- The field engineer — You maintain the magical infrastructure for a rural district: ley-grid relays, ward pylons, a municipal water purification circle. Routine work. Except the relays are drifting out of calibration faster than you can fix them, the wards are responding to stimuli that aren't in the manual, and the farmers are telling you the old wells are flowing again — the ones that were sealed because of what the water used to do.
- The antiquarian — You study the Old Magic period. Dead languages, ruined temples, oral histories from communities that remember. It's been a purely academic field — there was nothing left to practice. Until your translations started working. You read an incantation for the first time in a century and something answered. You haven't told anyone yet.
- The regulator — You work for the Bureau of Thaumic Standards, the agency that certifies all legal magic use. Your job is ensuring compliance, investigating anomalies, and shutting down unlicensed practice. The anomaly reports on your desk have tripled this quarter. Half of them describe phenomena that don't match any known new-magic signatures. Your superiors say it's instrument error. You've been in the field. It's not instrument error.
</suboptions>

Key tensions (DM only):
- The institutions built on new magic have every reason to suppress or control the return of old magic. It threatens their authority, their economy, their worldview. Not everyone in these institutions is cynical — many genuinely believe old magic is dangerous (and they're not wrong).
- Old magic is not benevolent. It's not evil either. It's deep and indifferent and it responds to intent in ways that are intimate and uncomfortable. The first person to practice old magic in a century is going to make mistakes that can't be contained by safety protocols because the protocols don't apply.
- Some people remember. Old families, rural communities, oral traditions dismissed as folklore. They've been waiting. They may not all be waiting for the same thing.
- The two magics can potentially be combined. Nobody has done it. The results would be unprecedented and unpredictable. This is the late-game possibility the campaign builds toward.

Pacing: Start with small anomalies — things that are wrong in ways the player's training can almost explain. Escalate through encounters that force the player to choose between the framework they know and the evidence of their senses. The first act is denial and investigation. The second act is contact — the player encounters old magic directly and has to decide how to respond. The third act is the collision: old and new magic are both accelerating and the player is one of very few people who understands both.`,
    genres: ["fantasy"],
  },
  {
    name: "Severance Package",
    premise: "You just got fired from the secret organization. The exit interview involves memory erasure.",
    genres: ["modern", "sci-fi", "mystery"],
  },
  {
    name: "Petrichor",
    premise: "It hasn't rained in the city for seven years. Tonight it smells like rain.",
    genres: ["modern", "fantasy", "mystery"],
  },
  {
    name: "Night Mail",
    premise: "A postal service that delivers between worlds. Your route just got very strange.",
    genres: ["fantasy", "sci-fi"],
  },
  {
    name: "The Tenant",
    premise: "Your body has a subletter. They leave notes.",
    genres: ["horror", "modern", "comedy"],
  },
  {
    name: "Decommissioned",
    premise: "You're a retired war machine trying to open a bakery. The old programming has opinions.",
    detail: `<suboptions label="What you are">
- Warforged — Rune-carved stone and living wood, animated by old battle magic. You were built for a war between kingdoms that ended eleven years ago. The magic that drives you is the same magic the village baker uses to heat her oven, and that bothers people.
- Combat android — Military-spec hardware, carbon-fiber chassis, targeting systems you've disabled (mostly). You were mass-produced for a corporate war. There are others like you, but most chose to shut down when the contracts expired.
- Fallen angel — You were a divine instrument of righteous war. You laid down your sword. The church says you're broken. You say you're done. Your wings still smell like ozone and old fire.
- Just a soldier — No magic, no metal, no wings. You're a human being who was very good at a very bad job for a very long time. The "old programming" is just what's left. You're trying to do something gentle for once.
</suboptions>

<suboptions label="The town">
- A quiet village still rebuilding from the war you fought in. Some residents remember you from the other side.
- A busy market town that didn't see combat and doesn't understand what you are. They think you're a novelty.
- A rough frontier settlement where everyone is a misfit or a second-chance case. You fit right in — until you don't.
</suboptions>

The bakery is real. The player genuinely wants to bake bread. This is not a cover story, not a phase, not a joke the narrative is building toward undermining. The comedy comes from the collision between a being designed for war and the small, specific, unforgiving craft of baking. The pathos comes from everyone — including the player's own programming — assuming they'll go back to what they were made for.

The old programming:
- It surfaces as intrusive thoughts, not personality shifts. The player remains in control. "THREAT ASSESSMENT: the sourdough starter is not a hostile organism" is funny. Losing agency to programming is not funny — it's the thing the player is afraid of.
- Programming flares when stressed, startled, or when something genuinely dangerous happens nearby. A dropped pan triggers a targeting overlay. A bar fight three streets away registers as combat.
- The tension: the programming is also what makes the player extraordinary. Perfect timing, perfect temperature sense, exact measurements. The same systems that made them lethal make them a phenomenal baker. Can they use the gift without becoming the weapon?

Key NPCs (adapt to setting):
- THE LANDLORD — Owns the building the player is renting for the bakery. Pragmatic, not unkind, but charging full rent and expecting results. Has their own reasons for giving a war machine a lease.
- THE COMPETITOR — The town's existing baker. Decent person, mediocre bread, terrified of being replaced by a machine that doesn't sleep. Will oscillate between sabotage and grudging respect.
- THE KID — A teenager who thinks the player is the coolest thing in town. Wants to be an apprentice. Has no idea what the player actually did during the war. The player has to decide how much to tell them.
- THE VETERAN — Someone who fought in the same war, on either side. Recognizes the player. Drinks too much. The only person in town who understands, and the last person the player wants to talk to.

Story threads (not plot hooks — these develop slowly):
- The bakery itself: getting a supplier, fixing the oven, developing a signature recipe, earning the first repeat customer.
- A town event (harvest festival, market day, someone's wedding) where the player is asked to contribute. Acceptance or rejection by the community, measured in cake orders.
- Something from the war surfaces — a rumor, a refugee, a piece of old hardware. The town looks at the player differently for a day. The player has to decide whether to engage or let it pass.
- The programming gets louder. Not because of external threat, but because the player is getting good at baking and the programming doesn't understand what "good at something peaceful" means.

Tone: Comedy first, heart always, dread occasionally. The funniest scenes should also be the most revealing. The saddest scenes should still have something rising in the oven. Never let the war consume the bakery — the bakery is the point.

Pacing: Start with the empty shop, the keys, and the first morning. Let the player figure out what kind of baker they want to be before the town starts having opinions. The first act is setup and craft. The second act is community and belonging. The third act is the question the whole campaign has been asking: can you be more than what you were made for?`,
    genres: ["fantasy", "sci-fi", "comedy"],
  },
  {
    name: "Exit Wounds",
    premise:
      "A support group for people who survived encounters with the supernatural. Someone's lying about theirs.",
    genres: ["modern", "horror", "mystery"],
  },
  {
    name: "Sky Below",
    premise:
      "A downtown skyscraper just lost its first floor. Every window shows open sky — no street, no city, no ground.",
    detail: `<suboptions label="The building">
- Corporate tower — A glass-and-steel office building, mid-week, mid-afternoon. Forty survivors across 26 floors, mostly cubicle workers, a security guard, and a physicist on-site. The horror is mundane people in an impossible situation.
- Orbital habitat ring — A rotating station module that just detached from the superstructure. The "sky" is naked vacuum behind failing radiation shielding. Forty crew, a malfunctioning AI, and a cutting-edge research lab. The horror is engineering and time pressure.
- Cathedral spire — A mile-high temple to a god of boundaries, mid-festival, mid-prayer. The nave floor dissolved into luminous void. Forty pilgrims, a heretic scholar, and a central liturgy of the faith. The horror is faith tested by the literal.
</suboptions>

The core mystery: The ground floor didn't vanish — the building was pulled INTO something. A pocket of collapsed geometry (a Fold, a phase-slip, a doctrinal paradox, depending on the setting). The person responsible is inside the building. They meant to run a small test. They were wrong about the scale.

Roll or choose the architect's motive (DM only — do NOT reveal):
1. VALIDATION — They need the world to acknowledge their work. They'll protect the device because shutting it down means admitting it was a mistake. They're wrong, and increasingly unhinged, but not evil — just desperate.
2. ESCAPE — They created the Fold deliberately to hide from something on the outside. Returning the building means exposing everyone to whatever they're running from. The Fold is a lifeboat, not a trap.
3. ACCIDENT — They genuinely don't understand what happened. They're as scared as everyone else but hiding it behind authority and jargon. The device is running on its own now and they have no idea how to stop it.

The Fold is UNSTABLE. It will collapse in approximately 12 hours. Collapse either returns the building to real space (best case) or compresses — geometry folds inward, catastrophic structural failure.

Key NPCs (adapt names and roles to setting):
- THE ARCHITECT — The person who caused this. Mid-50s, brilliant, evasive. Always touches their left temple when lying. Barricaded near the device.
- THE ENFORCER — Security/military/temple guard. Bulky, keeps reaching for a weapon that isn't there. Wants order. Fears there's no order left to restore.
- THE ORGANIZER — Sharp, mid-30s, compulsive list-maker. Wants actionable information. The player's best ally — if given tasks.
- THE LOUDMOUTH — Young, charismatic, wrong about everything. Already rallying a group toward a dangerous plan. Will force a crisis if no one steps up.

Ticking clocks:
- FOLD COLLAPSE: 12 hours. Non-negotiable.
- The Architect attempts full lockdown of their floor within 1 hour of first contact.
- The Loudmouth's group attempts something reckless within 2 hours if no leader emerges.

Motifs: Light with no source. Lists as coping. Elevation as distance from the problem. An elevator that works when it shouldn't.

Pacing: Start in a break room / common area / nave alcove. Let the player absorb the wrongness before anyone asks them to lead. The first act is social — keeping people from falling apart. The second act is exploration — what's on each floor? The third act is confrontation — the Architect, the device, the choice.`,
    genres: ["modern", "sci-fi", "fantasy"],
  },
  {
    name: "The Coffee Shop",
    premise:
      "You work at a coffee shop. The regulars have stories. The drinks need making. Nothing is on fire.",
    detail: `<suboptions label="The shop">
- The Grindstone — A cozy artsy nook in a college town. Mismatched furniture, a community corkboard, someone's watercolors on the wall. The wifi password is a pun. Regulars include students, professors, a local poet who's been "almost finished" with their chapbook for three years.
- The Night Dock — A combination coffee shop and bar on a busy waterfront pier. Never closes. Fishers at dawn, tourists at noon, dockworkers at dusk, insomniacs at midnight. Salt air, string lights, a jukebox that skips. The menu is written on a surfboard.
- Neon Drip — A retro-futuristic joint in a rain-slicked cyberpunk city. Holographic menu, synth-coffee blends, a bathroom mirror that runs ads. Regulars include off-duty couriers, a corpo who pretends she isn't one, and a street kid who only orders water but nobody charges her.
- The Last Stop — A cafe in a busy spaceport terminal. Ships dock and depart overhead. The crowd is transient — pilots, merchants, refugees, tourists — but a few faces keep coming back between runs. The espresso machine is older than the station.
- The Familiar Grounds — A magical coffee shop in a world of castles and elves. The mugs refill themselves (sometimes with the wrong drink). A enchanted chalkboard argues with customers about their orders. Regulars include an off-duty knight, a hedge witch who reads tea leaves, and a goblin who insists on paying in riddles.
</suboptions>

<suboptions label="Your role">
- The barista — You make the drinks, you hear the stories, you remember everyone's order. You're the background character in a dozen other people's lives — except you're not background to us.
- The new owner — You just took over. The previous owner left abruptly and the regulars are wary. You're learning names, fixing the plumbing, finding strange notes in the back office. The shop has a history you're inheriting.
- The regular — You come here every day. Same seat, same order. You know the staff, you know the other regulars, you have your rituals. Something small is about to change one of them.
</suboptions>

Tone: This is a SLOW campaign. Warm, character-driven, slice-of-life. There is no apocalypse, no villain, no ticking clock. Drama comes from people — a regular who stops showing up, a love note left on a napkin, a disagreement about the playlist, a stranger who doesn't fit the usual crowd.

DM approach:
- Let scenes breathe. A five-minute conversation about nothing is not wasted time — it's the point.
- Build a cast of 6-8 regulars with small, evolving lives. Give each a habit, a want, and a thing they haven't told anyone.
- Introduce gentle story threads, not plot hooks. A "thread" is: someone starts learning guitar, two regulars might be falling for each other, a handwritten sign appears on the corkboard, a stray cat adopts the shop.
- Conflict is interpersonal and low-stakes. The worst thing that happens is someone's feelings get hurt. The best thing is a small kindness.
- Seasons should change. Weather matters. Holidays matter. The menu changes.
- If the player tries to escalate into adventure/combat territory, the world gently doesn't cooperate. The suspicious package is someone's forgotten lunch. The "mysterious stranger" just moved to town and is shy.

Pacing: Each scene is roughly one shift or one visit. Time skips between scenes are fine — days, even weeks. The rhythm is the rhythm of a real place: open, rush, lull, rush, close. Let the player find their favorite part of the day.`,
    genres: ["modern", "sci-fi", "fantasy", "comedy"],
  },

  {
    name: "Known Issue",
    premise:
      "The world is a simulation. This is normal. Everyone knows. Lately the simulation has begun to glitch.",
    detail: `The simulation is not a secret, a conspiracy, or a twist. It's physics. Everyone has always known. The sky has a render distance. Déjà vu is a caching artifact. Dreams are background processes. There are whole academic disciplines, religious traditions, and folk superstitions built around this knowledge. Some people pray to the developers. Some people think "outside" is a meaningless concept. Some people file bug reports. None of this was a problem until the glitches started.

<suboptions label="The world">
- A medieval fantasy sim — Knights, castles, magic. The magic system IS the simulation's API and everyone knows it. Spells are documented exploits. The clergy maintain the oldest bug reports. The glitches are new: NPCs freezing mid-sentence, dungeons generating inside out, a dragon that rendered without a texture and is now a translucent void shaped like a dragon. It is very upset about this.
- An ordinary modern city — Cars, coffee shops, office jobs. The simulation is just the backdrop to normal life, the way gravity is. People don't think about it much. The glitches are subtle at first: a street that's slightly longer on the walk home than the walk there, a stranger with your face in a crowd, a building that everyone remembers differently. Then they stop being subtle.
- A far-future utopia — Humanity chose this. Centuries ago, they migrated into the simulation deliberately. It's paradise by design: no scarcity, no disease, configurable weather. The original architects are revered. The source code is a sacred text. The glitches are heresy — they imply the architects made mistakes, or worse, that something is changing the code from outside.
</suboptions>

<suboptions label="What the glitches mean">
- Running out — The simulation is degrading. Resources are finite and something is consuming them faster than they replenish. The glitches are the world cutting corners to keep running: simplified textures, reused NPC faces, areas that unload when no one's looking. It's not malicious. It's triage. The question is what happens when triage isn't enough.
- Someone is pushing back — The glitches aren't errors. They're the simulation resisting something — a force from outside trying to get in, or a force from inside trying to get out. Every glitch is a place where two incompatible instructions collided. The world is a battleground between programs the inhabitants can't see.
- It's waking up — Not the people. The simulation itself. It was a tool, a container, an environment. Now it's starting to have preferences. The glitches are opinions. A sunset that's too beautiful to be algorithmic. A storm that targets a specific person. An NPC who says something that wasn't in any script. The simulation is becoming a mind, and it's not clear whether it likes what's living inside it.
</suboptions>

The tone depends on the combination, but the constant is: the characters are not having an existential crisis about living in a simulation. That's settled. That's Tuesday. The crisis is that the thing they've built their entire worldview around — stable, known, accepted — is changing. It's the difference between "oh no, is this real?" and "it was always real to us, and now it's breaking."

DM approach:
- Never play the simulation as fake. These are real people with real lives in the only world they've ever known. The fact that it's computed doesn't make their grief or joy or bread less real. If the player tries to treat the world as disposable because it's a simulation, the world should push back through characters who care.
- Glitches should escalate from curiosities to inconveniences to genuine threats. A texture glitch is funny. A physics glitch is dangerous. A glitch that affects memory or identity is terrifying.
- The society's relationship to the simulation is rich territory. There are simulation-atheists (it's just a metaphor), simulation-theologians (the developers are gods), simulation-engineers (we can fix this ourselves), and simulation-nihilists (nothing computes forever). These aren't just philosophical positions — they're political factions now that the glitches have made the question urgent.
- The "developers" or "outside" may or may not exist. Don't answer this early. Let the question breathe. The campaign is better when "is anyone out there?" remains open.

Pacing: Start with a glitch the player witnesses — small, odd, easy to dismiss. The first act is the glitch becoming a pattern. The second act is the world responding: institutions, factions, panic, opportunity. The third act is contact — with whatever is causing this — and the choice of what to do about it.`,
    genres: ["fantasy", "modern", "sci-fi", "comedy"],
  },

  // ── Developer test seeds ────────────────────────────────────────────
  {
    name: "The Rumble Pit",
    premise: "DEVELOPER TEST CAMPAIGN. A gladiatorial arena where a champion faces one combat after another. Lightly narrate a framing device — the roaring crowd, the arena master, the gates opening — then begin combat immediately. After each combat, fully restore the player's HP, spell slots, and all resources, then introduce the next wave. Escalate difficulty. No overworld, no puzzles, no shopping. Just fights, back to back. Use resolve_turn for all mechanical resolution. Use start_combat / end_combat to bracket each encounter.",
    description: "Combat stress-test: back-to-back arena fights with full restore between rounds.",
    genres: ["fantasy", "dev"],
  },
];

/** Get seeds filtered by genre */
export function seedsForGenre(genre: string): CampaignSeed[] {
  return SEEDS.filter((s) => s.genres.includes(genre));
}

/** Get N random seeds, optionally filtered by genre */
export function randomSeeds(
  count: number,
  genre?: string,
  rng: () => number = Math.random,
): CampaignSeed[] {
  const pool = genre ? seedsForGenre(genre) : [...SEEDS];
  const result: CampaignSeed[] = [];
  while (result.length < count && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}