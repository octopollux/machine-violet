import Anthropic from "@anthropic-ai/sdk";
import type { CampaignConfig, PlayerConfig } from "../types/config.js";
import type { DMPersonality } from "../types/config.js";
import { PERSONALITIES, randomPersonality } from "../config/personalities.js";
import { randomSeeds } from "../config/seeds.js";
import { createDefaultConfig as defaultCombatConfig } from "../tools/combat/index.js";
import { getModel } from "../config/models.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import { loadPrompt } from "../prompts/load-prompt.js";

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
  themeColor: string;
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
    themeColor: generateThemeColor(characterName),
  };
}

// --- AI generation for full setup ---

const SETUP_GEN_SYSTEM = loadPrompt("setup-gen");

interface GeneratedCampaigns {
  campaigns: { name: string; premise: string }[];
}

interface GeneratedCharacters {
  characters: { name: string; description: string }[];
}

async function generateCampaignOptions(
  client: Anthropic,
  genre: string,
  mood: string,
): Promise<SetupStep> {
  // Static fallback
  const fallback = campaignStep(genre.toLowerCase().split(" ")[0]);

  try {
    const response = await client.messages.create({
      model: getModel("small"),
      max_tokens: TOKEN_LIMITS.SETUP_STEP,
      thinking: { type: "disabled" },
      system: SETUP_GEN_SYSTEM,
      messages: [{
        role: "user",
        content: `Generate 3 unique campaign premises for a ${mood} ${genre} tabletop RPG.
Return JSON: {"campaigns":[{"name":"Short Title","premise":"One sentence hook"},...]}`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed: GeneratedCampaigns = JSON.parse(text);
    if (parsed.campaigns?.length >= 2) {
      return {
        prompt: "What kind of adventure?",
        choices: [
          { label: "Surprise me", description: "Let the DM build a world from scratch" },
          ...parsed.campaigns.slice(0, 3).map((c) => ({ label: c.name, description: c.premise })),
        ],
        defaultIndex: 0,
      };
    }
  } catch { /* fall through to static */ }

  return fallback;
}

async function generateCharacterOptions(
  client: Anthropic,
  genre: string,
  mood: string,
  campaignPremise: string,
): Promise<SetupStep> {
  try {
    const response = await client.messages.create({
      model: getModel("small"),
      max_tokens: TOKEN_LIMITS.SETUP_STEP,
      thinking: { type: "disabled" },
      system: SETUP_GEN_SYSTEM,
      messages: [{
        role: "user",
        content: `Generate 3 unique player characters for a ${mood} ${genre} RPG campaign: "${campaignPremise}"
Each character should have a short evocative name and a one-sentence hook.
Return JSON: {"characters":[{"name":"Name","description":"One sentence hook"},...]}`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed: GeneratedCharacters = JSON.parse(text);
    if (parsed.characters?.length >= 2) {
      return {
        prompt: "Who are you?",
        choices: parsed.characters.slice(0, 3).map((c) => ({ label: c.name, description: c.description })),
        defaultIndex: 0,
      };
    }
  } catch { /* fall through to static */ }

  return {
    prompt: "Describe your character, or pick one.",
    choices: [
      { label: "Kael", description: "A wandering sellsword" },
      { label: "Sister Venn", description: "Excommunicated healer" },
      { label: "Rook", description: "A thief with a stolen secret" },
    ],
    defaultIndex: 0,
  };
}

// --- Full Setup (AI-powered) ---

/**
 * Full setup flow — uses AI (Haiku) to generate campaign and character options
 * tailored to the player's genre/mood selections.
 * Falls back to static options if no client is provided or AI fails.
 */
export async function fullSetup(
  getChoice: SetupCallback,
  client?: Anthropic,
): Promise<SetupResult> {
  // Genre
  const genreIdx = await resolveChoice(getChoice, GENRE_STEP);
  const genre = typeof genreIdx === "string" ? genreIdx : GENRE_STEP.choices[genreIdx].label;
  const genreKey = genre.toLowerCase().split(" ")[0];

  // System
  const systemIdx = await resolveChoice(getChoice, SYSTEM_STEP);
  const systemChoice = typeof systemIdx === "string" ? systemIdx : SYSTEM_STEP.choices[systemIdx].label;
  const system = systemChoice.includes("No system") ? null : systemChoice;

  // Mood
  const moodIdx = await resolveChoice(getChoice, MOOD_STEP);
  const mood = typeof moodIdx === "string" ? moodIdx : MOOD_STEP.choices[moodIdx].label;

  // Difficulty
  const diffIdx = await resolveChoice(getChoice, DIFFICULTY_STEP);
  const difficulty = typeof diffIdx === "string" ? diffIdx : DIFFICULTY_STEP.choices[diffIdx].label;

  // Campaign — AI-generated if client available, static fallback otherwise
  const campStep = client
    ? await generateCampaignOptions(client, genre, mood)
    : campaignStep(genreKey);
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

  // Character — AI-generated if client available
  const charStep = client
    ? await generateCharacterOptions(client, genre, mood, campaignPremise)
    : {
        prompt: "Describe your character, or pick one.",
        choices: [
          { label: "Kael", description: "A wandering sellsword" } as SetupChoice,
          { label: "Sister Venn", description: "Excommunicated healer" } as SetupChoice,
          { label: "Rook", description: "A thief with a stolen secret" } as SetupChoice,
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
    themeColor: generateThemeColor(characterName),
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
    color: result.themeColor,
  };

  return {
    name: result.campaignName,
    system: result.system ?? undefined,
    genre: result.genre,
    mood: result.mood,
    difficulty: result.difficulty,
    premise: result.campaignPremise,
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

/**
 * Generate a theme color for a character, suitable for dark TUI backgrounds.
 * Uses a simple hash of the name to pick a hue, with guaranteed minimum brightness.
 */
export function generateThemeColor(name: string): string {
  // Simple hash
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }

  // Convert to HSL with high saturation and lightness for dark backgrounds
  const hue = Math.abs(hash) % 360;
  const saturation = 60 + (Math.abs(hash >> 8) % 30);   // 60-90%
  const lightness = 55 + (Math.abs(hash >> 16) % 20);    // 55-75%

  // Convert HSL to hex
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lN - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function resolveChoice(
  getChoice: SetupCallback,
  step: SetupStep,
): Promise<number | string> {
  return getChoice(step);
}
