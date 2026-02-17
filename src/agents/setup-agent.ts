import type { CampaignConfig, PlayerConfig } from "../types/config.js";
import type { DMPersonality } from "../types/config.js";
import { PERSONALITIES, randomPersonality } from "../config/personalities.js";
import { randomSeeds } from "../config/seeds.js";
import { createDefaultConfig as defaultCombatConfig } from "../tools/combat/index.js";

// --- Types ---

export interface SetupChoice {
  label: string;
  description?: string;
}

export interface SetupStep {
  prompt: string;
  choices: SetupChoice[];
  defaultIndex: number;
}

export interface SetupResult {
  genre: string;
  system: string | null;
  campaignName: string;
  campaignPremise: string;
  mood: string;
  difficulty: string;
  personality: DMPersonality;
  playerName: string;
  characterName: string;
  characterDescription: string;
}

export type SetupCallback = (step: SetupStep) => Promise<number | string>;

// --- Setup Steps (data-driven) ---

const GENRE_STEP: SetupStep = {
  prompt: "What kind of world?",
  choices: [
    { label: "Classic fantasy", description: "Swords, sorcery, dragons, dungeons" },
    { label: "Sci-fi", description: "Space, technology, the unknown" },
    { label: "Modern supernatural", description: "Our world, but darker" },
    { label: "Post-apocalyptic", description: "After the end, survival" },
  ],
  defaultIndex: 0,
};

const SYSTEM_STEP: SetupStep = {
  prompt: "What game system?",
  choices: [
    { label: "No system — pure narrative", description: "The DM decides everything" },
    { label: "FATE Accelerated", description: "Light mechanics, narrative-first" },
    { label: "24XX", description: "Minimal dice, fast play" },
  ],
  defaultIndex: 0,
};

const MOOD_STEP: SetupStep = {
  prompt: "Set the mood.",
  choices: [
    { label: "Heroic", description: "Glory and triumph" },
    { label: "Grimdark", description: "Survival and hard choices" },
    { label: "Whimsical", description: "Humor and wonder" },
    { label: "Tense", description: "Mystery and paranoia" },
  ],
  defaultIndex: 0,
};

const DIFFICULTY_STEP: SetupStep = {
  prompt: "How forgiving should I be?",
  choices: [
    { label: "Gentle", description: "The story goes on" },
    { label: "Balanced", description: "Consequences, but fair" },
    { label: "Unforgiving", description: "Death is real" },
  ],
  defaultIndex: 1,
};

function personalityStep(): SetupStep {
  return {
    prompt: "Who will be your Dungeon Master?",
    choices: PERSONALITIES.map((p) => ({
      label: p.name,
      description: p.prompt_fragment.slice(0, 80) + "...",
    })),
    defaultIndex: 0,
  };
}

function campaignStep(genre: string): SetupStep {
  const seeds = randomSeeds(3, genre);
  return {
    prompt: "What kind of adventure?",
    choices: [
      { label: "Surprise me", description: "Build a world from scratch" },
      ...seeds.map((s) => ({ label: s.name, description: s.premise })),
    ],
    defaultIndex: 0,
  };
}

// --- Fast Path ---

/**
 * "Just Jump In" fast path — 4 prompts, Enter = random at each.
 * Returns a fully populated SetupResult with randomized defaults.
 */
export async function fastPathSetup(
  getChoice: SetupCallback,
): Promise<SetupResult> {
  // Genre
  const genreIdx = await resolveChoice(getChoice, GENRE_STEP);
  const genre = typeof genreIdx === "string" ? genreIdx : GENRE_STEP.choices[genreIdx].label;
  const genreKey = genre.toLowerCase().split(" ")[0];

  // System (default: no system)
  const systemIdx = await resolveChoice(getChoice, SYSTEM_STEP);
  const systemChoice = typeof systemIdx === "string" ? systemIdx : SYSTEM_STEP.choices[systemIdx].label;
  const system = systemChoice.includes("No system") ? null : systemChoice;

  // Personality
  const persStep = personalityStep();
  const persIdx = await resolveChoice(getChoice, persStep);
  const personality = typeof persIdx === "string"
    ? { name: "Custom", prompt_fragment: persIdx }
    : PERSONALITIES[persIdx] ?? randomPersonality();

  // Character (uses campaign seed)
  const charStep: SetupStep = {
    prompt: "Who are you?",
    choices: [
      { label: "Kael", description: "A wandering sellsword with a debt and a bad reputation" },
      { label: "Sister Venn", description: "Excommunicated healer searching for a forbidden cure" },
      { label: "Rook", description: "A thief who accidentally stole something that matters" },
    ],
    defaultIndex: 0,
  };
  const charIdx = await resolveChoice(getChoice, charStep);
  const charChoice = typeof charIdx === "string" ? charIdx : charStep.choices[charIdx];
  const characterName = typeof charChoice === "string" ? charChoice : charChoice.label;
  const characterDescription = typeof charChoice === "string"
    ? charChoice
    : charChoice.description ?? "";

  // Pick a random seed
  const seeds = randomSeeds(1, genreKey);
  const seed = seeds[0] ?? { name: "The Unknown Path", premise: "An adventure awaits." };

  return {
    genre,
    system,
    campaignName: seed.name,
    campaignPremise: seed.premise,
    mood: "Balanced",
    difficulty: "Balanced",
    personality,
    playerName: "Player",
    characterName,
    characterDescription,
  };
}

// --- Full Setup (Sonnet-powered) ---

/**
 * Full setup flow — driven by the setup agent (Sonnet).
 * Each step presents choices via the callback.
 */
export async function fullSetup(
  getChoice: SetupCallback,
): Promise<SetupResult> {
  // Genre
  const genreIdx = await resolveChoice(getChoice, GENRE_STEP);
  const genre = typeof genreIdx === "string" ? genreIdx : GENRE_STEP.choices[genreIdx].label;
  const genreKey = genre.toLowerCase().split(" ")[0];

  // System
  const systemIdx = await resolveChoice(getChoice, SYSTEM_STEP);
  const systemChoice = typeof systemIdx === "string" ? systemIdx : SYSTEM_STEP.choices[systemIdx].label;
  const system = systemChoice.includes("No system") ? null : systemChoice;

  // Campaign
  const campStep = campaignStep(genreKey);
  const campIdx = await resolveChoice(getChoice, campStep);
  let campaignName: string;
  let campaignPremise: string;
  if (typeof campIdx === "string") {
    campaignName = campIdx;
    campaignPremise = campIdx;
  } else if (campIdx === 0) {
    // "Surprise me"
    campaignName = "A New Story";
    campaignPremise = "The DM will build the world.";
  } else {
    const seed = campStep.choices[campIdx];
    campaignName = seed.label;
    campaignPremise = seed.description ?? "";
  }

  // Mood
  const moodIdx = await resolveChoice(getChoice, MOOD_STEP);
  const mood = typeof moodIdx === "string" ? moodIdx : MOOD_STEP.choices[moodIdx].label;

  // Difficulty
  const diffIdx = await resolveChoice(getChoice, DIFFICULTY_STEP);
  const difficulty = typeof diffIdx === "string" ? diffIdx : DIFFICULTY_STEP.choices[diffIdx].label;

  // Personality
  const persStep = personalityStep();
  const persIdx = await resolveChoice(getChoice, persStep);
  const personality = typeof persIdx === "string"
    ? { name: "Custom", prompt_fragment: persIdx }
    : PERSONALITIES[persIdx] ?? randomPersonality();

  // Player name
  const playerStep: SetupStep = {
    prompt: "What's your name?",
    choices: [{ label: "Skip", description: "Use 'Player'" }],
    defaultIndex: 0,
  };
  const playerChoice = await resolveChoice(getChoice, playerStep);
  const playerName = typeof playerChoice === "string" ? playerChoice : "Player";

  // Character
  const charStep: SetupStep = {
    prompt: "Describe your character, or pick one.",
    choices: [
      { label: "Kael", description: "A wandering sellsword" },
      { label: "Sister Venn", description: "Excommunicated healer" },
      { label: "Rook", description: "A thief with a stolen secret" },
    ],
    defaultIndex: 0,
  };
  const charIdx = await resolveChoice(getChoice, charStep);
  const charChoice = typeof charIdx === "string" ? charIdx : charStep.choices[charIdx];
  const characterName = typeof charChoice === "string" ? charChoice : charChoice.label;
  const characterDescription = typeof charChoice === "string"
    ? charChoice
    : charChoice.description ?? "";

  return {
    genre,
    system,
    campaignName,
    campaignPremise,
    mood,
    difficulty,
    personality,
    playerName,
    characterName,
    characterDescription,
  };
}

/**
 * Build a CampaignConfig from setup results.
 */
export function buildCampaignConfig(result: SetupResult): CampaignConfig {
  const player: PlayerConfig = {
    name: result.playerName,
    character: result.characterName,
    type: "human",
  };

  return {
    name: result.campaignName,
    system: result.system ?? undefined,
    genre: result.genre,
    mood: result.mood,
    difficulty: result.difficulty,
    dm_personality: result.personality,
    players: [player],
    combat: defaultCombatConfig(),
    context: {
      retention_exchanges: 5,
      max_conversation_tokens: 8000,
      tool_result_stub_after: 2,
    },
    recovery: {
      auto_commit_interval: 3,
      max_commits: 500,
      enable_git: true,
    },
    choices: {
      campaign_default: "often",
      player_overrides: {},
    },
  };
}

// --- Helpers ---

async function resolveChoice(
  getChoice: SetupCallback,
  step: SetupStep,
): Promise<number | string> {
  return getChoice(step);
}
