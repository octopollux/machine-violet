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
    genres: ["horror", "mystery"],
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
    genres: ["mystery", "modern"],
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
    premise: "The Chosen Ones all died in Act One. You're the backup cast.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "Palimpsest",
    premise: "The city rebuilds itself every night from memories. Yours are leaking in.",
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
    premise: "You're a retired war golem trying to open a bakery. The old programming has opinions.",
    genres: ["fantasy", "comedy"],
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
- Corporate tower — A glass-and-steel office building, mid-week, mid-afternoon. Forty survivors across 26 floors, mostly cubicle workers, a security guard, and one physicist who knows more than she's saying. The horror is mundane people in an impossible situation.
- Orbital habitat ring — A rotating station module that just detached from the superstructure. The "sky" is naked vacuum behind failing radiation shielding. Forty crew, a malfunctioning AI, and a research lab that was running an unauthorized experiment. The horror is engineering and time pressure.
- Cathedral spire — A mile-high temple to a god of boundaries, mid-festival, mid-prayer. The nave floor dissolved into luminous void. Forty pilgrims, a heretic scholar, and a liturgy that might be an instruction manual. The horror is faith tested by the literal.
</suboptions>

The core mystery: The ground floor didn't vanish — the building was pulled INTO something. A pocket of collapsed geometry (a Fold, a phase-slip, a doctrinal paradox, depending on the setting). The person responsible is inside the building. They meant to run a small test. They were wrong about the scale.

Roll or choose the architect's motive (DM only — do NOT reveal):
1. VALIDATION — They need the world to acknowledge their work. They'll protect the device because shutting it down means admitting it was a mistake. They're wrong, and increasingly unhinged, but not evil — just desperate.
2. ESCAPE — They created the Fold deliberately to hide from something on the outside. Returning the building means exposing everyone to whatever they're running from. The Fold is a lifeboat, not a trap.
3. ACCIDENT — They genuinely don't understand what happened. They're as scared as everyone else but hiding it behind authority and jargon. The device is running on its own now and they have no idea how to stop it.

The fold is UNSTABLE. It will collapse in approximately 12 hours. Collapse either returns the building to real space (best case) or compresses — geometry folds inward, catastrophic structural failure.

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