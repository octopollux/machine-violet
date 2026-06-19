import type { SubagentResult } from "../subagent.js";
import type { SetupResult } from "../setup-agent.js";
import { generateThemeColor } from "../setup-agent.js";
import { CAMPAIGN_SCOPES, type CampaignScope, type MechanicsMode } from "@machine-violet/shared/types/config.js";
import { loadAllPersonalities, getPersonality } from "../../config/personality-loader.js";
import { loadAllWorlds, worldSummaries, loadWorldBySlug } from "../../config/world-loader.js";
import { normalizeForks, assembleCampaignDetail } from "../../config/world-forks.js";
import type { WorldFile, WorldFork } from "@machine-violet/shared/types/world.js";
import { rollDice } from "../../tools/dice/index.js";
import { KNOWN_SYSTEMS, readChargenSection } from "../../config/systems.js";
import type { SystemComplexity } from "../../config/systems.js";
import { getEffortConfig } from "../../config/models.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { processIncludes } from "../../prompts/process-includes.js";
import { resolveImageStyleLine } from "../../prompts/image-style.js";
import { dumpContext, dumpThinking } from "../../config/context-dump.js";
import {
  extractStatus,
  RETRYABLE_STATUS,
  retryDelay,
  sleep,
} from "../../utils/retry.js";
import type {
  LLMProvider, ChatParams, ChatResult,
  NormalizedMessage, NormalizedTool, NormalizedUsage,
  SystemBlock, ContentPart,
} from "../../providers/types.js";
import type { FileIO } from "../scene-manager.js";
import { handleImageGenerated } from "../image-handler.js";
import { campaignPaths } from "../../tools/filesystem/index.js";
import { norm } from "../../utils/paths.js";
import { slugify } from "../../utils/slug.js";
import { logEvent } from "../../context/engine-log.js";

// --- Types ---

export interface SetupTurnResult extends SubagentResult {
  /** Non-null when the agent called finalize_setup */
  finalized?: SetupResult;
  /** Non-null when the agent called present_choices — must be resolved before continuing */
  pendingChoices?: { prompt: string; choices: string[]; descriptions?: string[] };
  /**
   * Portrait drafts the setup agent generated during this turn (persisted
   * to the __setup__ scratch campaign by the time this returns). The
   * caller is expected to broadcast a `display_image` TUI event for each
   * so the client renders the draft inline. Empty/absent means no
   * portraits were emitted this turn.
   */
  imageDisplays?: { filename: string; intent: "character_portrait" }[];
}

/**
 * A multi-turn conversational setup session.
 * The agent chats with the player to collaboratively build a campaign,
 * then calls finalize_setup when it has enough information.
 * It can also present structured choices via the present_choices tool.
 */
export interface SetupConversation {
  /** Send the opening message (no user input yet) */
  start(onDelta: (delta: string) => void): Promise<SetupTurnResult>;
  /** Send a player message and get the next response */
  send(text: string, onDelta: (delta: string) => void): Promise<SetupTurnResult>;
  /** Resolve a pending present_choices tool call with the player's selection */
  resolveChoice(selectedText: string, onDelta: (delta: string) => void): Promise<SetupTurnResult>;
  /** True while a present_choices tool call is unresolved — the next user
   *  turn must supply a matching tool_result (either selection or dismissal). */
  readonly hasPendingChoice: boolean;
}

/**
 * Outcome of dispatching one setup tool call through the shared dispatcher
 * (`runToolDispatch`). `content`/`isError` form the tool_result body for every
 * non-suspending tool. `pendingChoices` is set ONLY by present_choices, which
 * suspends the turn: when present, the caller must capture the choices and
 * record NO tool_result — that result is synthesized later from the player's
 * selection in resolveChoice/send. Both dispatch paths (the codex
 * `dispatchTool` closure and the legacy per-tool loop) interpret this same
 * shape, so each tool body has one source of truth.
 */
interface ToolDispatchOutcome {
  content: string;
  isError: boolean;
  pendingChoices?: { prompt: string; choices: string[]; descriptions?: string[] };
}

// --- Tool definitions ---

const FINALIZE_TOOL: NormalizedTool = {
  name: "finalize_setup",
  description:
    "Call this when you have gathered enough information to create the campaign. " +
    "All fields are required. Infer reasonable defaults for anything the player didn't specify.",
  inputSchema: {
    type: "object" as const,
    properties: {
      genre: { type: "string", description: "Genre (e.g. 'Classic fantasy', 'Sci-fi', 'Modern supernatural')" },
      system: { type: "string", description: "Game system slug from the available systems list (e.g. 'dnd-5e', 'fate-accelerated'), or null for pure narrative. Use the slug, not the display name.", nullable: true },
      campaign_name: { type: "string", description: "Short evocative campaign title. When the player picked a player-facing fork option from a seeded world, you may suffix with that option's name: `<World Name> - <Option Name>` (e.g. 'Palimpsest - The Dreaming Souk'). Skip the suffix for fully custom campaigns or seeds without player forks." },
      campaign_premise: { type: "string", description: "One-paragraph campaign hook" },
      mood: { type: "string", description: "Mood (e.g. 'Heroic', 'Grimdark', 'Whimsical', 'Tense')" },
      difficulty: { type: "string", description: "Difficulty ('Gentle', 'Balanced', 'Unforgiving')" },
      campaign_scope: {
        type: "string",
        enum: ["one-shot", "few-sessions", "grand-campaign", "open-ended"],
        description: "Intended scope of the campaign. 'one-shot' = single session (~few hours). 'few-sessions' = a small arc, 2-4 sessions. 'grand-campaign' = long-form, many sessions, slow burn welcome. 'open-ended' = no fixed destination, living-world style. Default to 'few-sessions' if not discussed.",
      },
      dm_personality: { type: "string", description: "DM personality name from the available list, or a custom name if the player described their own" },
      dm_personality_prompt: { type: "string", description: "For custom personalities only: a 2-3 sentence prompt fragment describing the DM's narrative voice and style (e.g. 'You are The Captain. You narrate with dry naval authority...'). Omit when using a personality from the available list." },
      player_name: { type: "string", description: "Player's real name, or 'Player'" },
      character_name: { type: "string", description: "Player character's name" },
      character_description: { type: "string", description: "One-sentence character concept" },
      character_details: { type: "string", description: "Mechanical character details gathered during setup (class, skills, approaches, etc). Free-form text. Omit or null for pure narrative.", nullable: true },
      campaign_detail: { type: "string", description: "DM-only detail. For a FULLY CUSTOM campaign (no seeded world) this is the entire DM detail. For a seeded world, the seed's own detail is assembled in code from your fork_selections; anything you pass here is APPENDED to it — use this only to record a specific setup-time DM directive you were asked to add (e.g. a chosen visual-style include). Omit if there is nothing to add.", nullable: true },
      world_slug: { type: "string", description: "Slug of the world file used (from load_world). Required when the campaign is built from a seeded world — it's how the engine re-loads the world to assemble DM detail and materialize content. Omit only for fully custom campaigns.", nullable: true },
      fork_selections: {
        type: "object",
        description: "How you resolved the chosen world's forks (from load_world), as a map of forkId → optionId. Include an entry for EVERY fork the world declared: player forks (the option the player picked) and agent forks (the option you rolled or chose). Use the exact ids shown by load_world. Omit for fully custom campaigns or worlds with no forks.",
        additionalProperties: { type: "string" },
        nullable: true,
      },
      age_group: { type: "string", enum: ["child", "teenager", "adult"], description: "Player's age group. Set to 'child' or 'teenager' if the player clearly indicates so. Otherwise — including when age is not discussed or the player declines — set to 'adult'. Always include this field." },
      content_preferences: { type: "string", description: "Any content preferences or sensitivities the player mentioned during setup (one per line). Only include if the player volunteered them — never prompt for these.", nullable: true },
      image_generation: {
        type: "string",
        enum: ["on", "off"],
        description: "Player's answer to the image-generation consent question. 'on' if they said yes, 'off' if they said no. Only include this field if you actually asked the consent question (which only happens when the active provider/model supports image generation — see the Image generation section of your prompt). Omit when not asked.",
        nullable: true,
      },
      mechanics_mode: {
        type: "string",
        enum: ["dm-managed", "player-facing"],
        description: "Player's answer to the mechanics-handling question. 'dm-managed' if they want you to run the rules silently behind the scenes; 'player-facing' if they want to engage the mechanics directly. ONLY include this field if you actually asked the question, which only happens when the chosen system is light or ultra-light (see the System selection section of your prompt). Omit for crunchy systems and pure-narrative campaigns.",
        nullable: true,
      },
      handoff_note: { type: "string", description: "Handoff postcard for the DM's first turn. Free-form prose — the DM sees this once as priming for the opening scene. Include: what the player said about their character IN THEIR OWN WORDS (quote or paraphrase closely, don't sanitize), any freeform remarks they made about the world / tone / things they want or don't want, and anything you (the setup agent) want to pass along to the DM — hooks you promised, tone cues the structured fields don't capture, unresolved ambiguities. Write it as a direct note to the DM, not as narration. A paragraph or two is usually right. Always include this field." },
      opening_scene: { type: "string", description: "ONE sentence telling the DM where and how to OPEN the very first turn — the concrete situation the player character is in when the curtain rises. Bias hard toward a character-grounded entry beat (waking somewhere, a quiet moment, mid-journey, a conversation, an ordinary task) rather than dropping the player straight onto the campaign's main objective or a crisis — a story should start with the PC, then let plot ensue. Ground it in this specific PC and premise; if the seed's setup-only guidance suggests an opening, honor it. Written as a direct instruction to the DM, not as narration (e.g. \"Open with the PC asleep in a warm bed, woken by frantic hammering at the door\" or \"Begin mid-flight on the back of their pet dragon, the city shrinking below\"). Always include this field." },
    },
    required: [
      "genre", "campaign_name", "campaign_premise", "mood",
      "difficulty", "dm_personality", "player_name",
      "character_name", "character_description", "handoff_note",
      "opening_scene",
    ],
  },
};

const PRESENT_CHOICES_TOOL: NormalizedTool = {
  name: "present_choices",
  description:
    "Present the player with a set of structured choices in a selection modal. " +
    "Use this when you want to offer 2-10 concrete options (e.g. genre, character concepts, campaign premises). " +
    "The player's selection will be returned as the tool result. " +
    "You can include a short text message before calling this tool to give context. " +
    "If a choice needs explanation, provide a descriptions array (same length as choices) — " +
    "the description for the highlighted choice is shown in a preview region.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Short prompt shown above the choices (e.g. 'What kind of world?')" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "2-10 short option labels for the player to choose from",
        minItems: 1,
        maxItems: 10,
      },
      descriptions: {
        type: "array",
        items: { type: "string" },
        description: "Optional per-choice descriptions (same length as choices). Shown as a preview when the choice is highlighted.",
      },
    },
    required: ["prompt", "choices"],
  },
};

const LOAD_WORLD_TOOL: NormalizedTool = {
  name: "load_world",
  description:
    "Load a world's forks (variant decision points) and config hints by slug. " +
    "Use this after the player shows interest in a specific seeded world. " +
    "Returns the world's forks — player forks to present, agent forks for you to " +
    "decide — and any system/mood/difficulty/scope hints. The DM-only premise is " +
    "NOT returned: it is assembled in code from your fork_selections, so you never " +
    "carry it. Resolve every fork and report your choices in finalize_setup.fork_selections.",
  inputSchema: {
    type: "object" as const,
    properties: {
      slug: { type: "string", description: "The world slug (e.g. 'the-shattered-crown')" },
    },
    required: ["slug"],
  },
};

const ROLL_DICE_TOOL: NormalizedTool = {
  name: "roll_dice",
  description:
    "Roll dice during setup. Primary use: resolve an agent-decided fork at random — " +
    "roll `1dN` to pick uniformly among a fork's N options (option 1 = result 1, etc.), " +
    "which avoids biasing every campaign toward the first/most-obvious branch. " +
    "Returns the individual rolls and the total.",
  inputSchema: {
    type: "object" as const,
    properties: {
      expression: { type: "string", description: "Dice expression, e.g. \"1d4\", \"2d6+1\", \"1d20\"." },
      reason: { type: "string", description: "Optional short reason (e.g. 'genre-wrapper fork').", nullable: true },
    },
    required: ["expression"],
  },
};

/**
 * Render a world's forks + setup-only guidance + config hints for the setup
 * agent. Deliberately omits the DM-only premise prose (base `detail` and each
 * option's `detail`) — that is assembled in code at finalize from the agent's
 * `fork_selections`, so the setup agent never carries the DM's secrets in its
 * context. The seed's `setup_detail` IS surfaced here (with includes expanded):
 * it's setup-agent-only material that never reaches the DM.
 */
export function renderWorldForAgent(world: WorldFile): string {
  const parts: string[] = [];
  const forks = normalizeForks(world);
  const playerForks = forks.filter((f) => f.chooser === "player");
  const agentForks = forks.filter((f) => f.chooser === "agent");

  const renderFork = (f: WorldFork): string =>
    `- Fork \`${f.id}\` — ${f.label}${f.prompt ? ` _(${f.prompt})_` : ""}\n` +
    f.options.map((o) => `    - \`${o.id}\`: **${o.name}** — ${o.description}`).join("\n");

  if (playerForks.length) {
    parts.push(
      "## Player forks — present each to the player via present_choices\n" +
      "Use each option's **name** as the choice label and its description as the choice description. " +
      "When the player picks, record it in finalize_setup.fork_selections as `{ \"<forkId>\": \"<optionId>\" }`.\n\n" +
      playerForks.map(renderFork).join("\n"),
    );
  }
  if (agentForks.length) {
    parts.push(
      "## Agent forks — you decide these (DM-only; never shown to the player)\n" +
      "For each, roll `roll_dice` with `1dN` (N = number of options) to pick at random, or choose the option " +
      "that best fits the player's stated preferences. Record each in finalize_setup.fork_selections.\n\n" +
      agentForks.map(renderFork).join("\n"),
    );
  }
  if (!forks.length) {
    parts.push("This world declares no forks — nothing to resolve here.");
  }

  // Setup-agent-only guidance. Surfaced here with includes expanded; never
  // assembled into the DM's campaign_detail. The setup prompt tells the agent
  // how to act on it (e.g. present a scope/pacing variant) and to keep it from
  // the player and the DM.
  if (world.setup_detail?.trim()) {
    parts.push(
      "## Setup-only guidance — for you, the setup agent\n" +
      "Act on this (e.g. present any scope/pacing options it describes, weigh any notes), " +
      "but NEVER reveal it to the player or carry it into the campaign for the DM.\n\n" +
      processIncludes(world.setup_detail),
    );
  }

  if (world.system) parts.push(`Suggested system: ${world.system}`);
  if (world.mood) parts.push(`Suggested mood: ${world.mood}`);
  if (world.difficulty) parts.push(`Suggested difficulty: ${world.difficulty}`);
  if (world.campaign_scope) {
    parts.push(`Required campaign_scope: ${world.campaign_scope}`);
    parts.push("(The world above defines a required campaign scope. Use the slug exactly as shown — no extra text — in finalize_setup, and do NOT ask the player about campaign length.)");
  }
  return parts.length > 0 ? parts.join("\n\n") : "World loaded but has no additional detail.";
}

/** Dispatch a setup-time `roll_dice` call. */
function renderRollDice(input: Record<string, unknown>): { content: string; isError: boolean } {
  const expression = typeof input.expression === "string" ? input.expression.trim() : "";
  if (!expression) return { content: "roll_dice requires an `expression` (e.g. \"1d4\").", isError: true };
  try {
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
    const out = rollDice({ expression, reason });
    const rendered = out.results
      .map((r) => `${r.expression} → [${r.rolls.join(", ")}] = ${r.total}`)
      .join("; ");
    return { content: rendered, isError: false };
  } catch (e) {
    return { content: `roll_dice error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

const GENERATE_IMAGE_TOOL: NormalizedTool = {
  name: "generate_image",
  description:
    "Generate the player character's reference sheet: a SINGLE landscape image showing the SAME full-body character " +
    "from three angles side by side against one plain black background — a front view, a three-quarter view from the " +
    "front-left, and a three-quarter view from the rear-right. " +
    "Use ONLY for the character reference sheet during chargen — never for scenes or other illustrations during setup. " +
    "This sheet becomes the canonical reference the DM later conditions in-game art on, so the multiple angles are what " +
    "keep generated scenes from defaulting to a stiff, camera-facing pose. " +
    "The image is shown to the player automatically. After showing each draft, ask the player whether it looks right or " +
    "what to adjust, then call this again with an updated prompt if needed. " +
    "When the player confirms, call `set_portrait` with that draft's filename to keep it. " +
    "Write the prompt as the CHARACTER and the THREE VIEWS only: describe the character once (build, clothing, " +
    "footwear, mood, expression), then call for the three side-by-side angles (front, front-left three-quarter, " +
    "rear-right three-quarter) against a plain black background. Do NOT specify an art medium or lighting — the engine " +
    "renders the CHARACTER in the campaign's visual style against that plain black background (a clean reference sheet, " +
    "not a scene), so the character card matches the look the DM will condition in-game art on. " +
    "You don't choose render effort or aspect here either — the engine always renders the chargen sheet at a fixed " +
    "standard quality (fast enough to iterate, the ceiling a character sheet needs) and landscape framing (the three " +
    "views need the width). Just write the character.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "Vivid description of the character's full-body appearance — clothing, build, footwear, mood, expression — described once, since the character is identical in every view. End by calling for the three side-by-side angles (front, front-left three-quarter, rear-right three-quarter) on a plain black background. The model composes the image from this; be specific.",
      },
    },
    required: ["prompt"],
  },
};

const SET_PORTRAIT_TOOL: NormalizedTool = {
  name: "set_portrait",
  description:
    "Keep one of the generated portrait drafts as the final character portrait. Call this once the " +
    "player has confirmed they're happy with a draft (or call it on the latest draft if the player " +
    "is moving on without explicit love). Pass the character's name and the filename of the draft " +
    "to keep — the engine copies it to the canonical character portrait path. Drafts not chosen " +
    "are left in place for audit; they don't follow the campaign forward.",
  inputSchema: {
    type: "object" as const,
    properties: {
      character_name: {
        type: "string",
        description: "The character's name as established during chargen. Must match the name you'll pass to finalize_setup.",
      },
      draft_filename: {
        type: "string",
        description: "Filename of the draft to promote (e.g. 'portrait-draft-1716800000000.png'). Just the basename, not a full path.",
      },
    },
    required: ["character_name", "draft_filename"],
  },
};

const BASE_TOOLS = [FINALIZE_TOOL, PRESENT_CHOICES_TOOL, LOAD_WORLD_TOOL, ROLL_DICE_TOOL];
const IMAGE_GEN_TOOLS = [GENERATE_IMAGE_TOOL, SET_PORTRAIT_TOOL];

/**
 * Placeholder fallback style for the chargen reference sheet when the chosen
 * seed declares no `image_style` (or the campaign is fully custom). Per the
 * visual-style MVP wiring — `CinematicFilm` until per-seed defaults are graded.
 */
const DEFAULT_PORTRAIT_STYLE = "CinematicFilm";

/**
 * Reference-sheet framing for the chargen portrait, appended after the campaign
 * style line. The campaign style governs how the CHARACTER renders; this keeps
 * the sheet a functional turnaround on plain black and strips the chrome the
 * scene-oriented style directives drag along (captions, letterbox/frames,
 * HUD/timestamp overlays, vignettes) — none of which belong on a character card.
 */
const PORTRAIT_SHEET_FRAMING =
  "This is a character REFERENCE SHEET, not a scene: place all three views of the same character " +
  "against a plain, empty, flat black background — no environment, set, props, furniture, or location " +
  "of any kind. Apply the visual style above ONLY to how the CHARACTER itself is rendered (its medium, " +
  "grade, linework, texture, lighting, and finish). Strip any other trappings the style might add: NO " +
  "caption, title, lettering, or text of any kind; NO frame, border, letterbox bars, vignette, or matte; " +
  "NO HUD, on-screen display, timestamp, watermark, or logo. Just the three clean character views on plain black.";

/**
 * Compose the chargen reference-sheet prompt from three ordered parts: the
 * agent's character + three-view description, then the campaign style's `# Style`
 * directive, then {@link PORTRAIT_SHEET_FRAMING} LAST. The order is the whole
 * point — the style line stamps the CHARACTER's render treatment, and the
 * framing, stated last, wins the composition so scene-oriented styles can't
 * stage the turnaround or drag along captions/frames/HUD chrome.
 *
 * `styleName` is the chosen seed's `image_style` (undefined for a fully custom
 * campaign); an unknown or missing style falls back to the {@link
 * DEFAULT_PORTRAIT_STYLE} placeholder. Exported so the exact prompt shape is
 * unit-testable without driving a live portrait render.
 */
export function composeChargenPortraitPrompt(character: string, styleName?: string): string {
  const name = styleName?.trim() || DEFAULT_PORTRAIT_STYLE;
  const styleLine = resolveImageStyleLine(name) ?? resolveImageStyleLine(DEFAULT_PORTRAIT_STYLE);
  return [character, styleLine, PORTRAIT_SHEET_FRAMING].filter(Boolean).join("\n\n");
}

// --- System prompt ---

/** Group systems by complexity tier label. */
function groupByTier(systems: typeof KNOWN_SYSTEMS): { light: typeof KNOWN_SYSTEMS; crunchy: typeof KNOWN_SYSTEMS } {
  const lightComplexities: SystemComplexity[] = ["ultra-light", "light"];
  return {
    light: systems.filter((s) => lightComplexities.includes(s.complexity)),
    crunchy: systems.filter((s) => !lightComplexities.includes(s.complexity)),
  };
}

function formatSystemLine(s: typeof KNOWN_SYSTEMS[number]): string {
  const ruleCard = s.hasRuleCard ? " ✦ full rule card" : "";
  return `- \`${s.slug}\` — ${s.name}: ${s.description}${ruleCard}`;
}

/** Known player info passed from the machine-scope players directory. */
export interface KnownPlayer {
  name: string;
  ageGroup?: string;
}

/** Fisher-Yates shuffle (returns a new array). */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the setup system prompt as SystemBlock[] with cache breakpoints.
 *
 * Three stability tiers mirror the playing-phase prefix-builder pattern:
 *
 *   Tier 1 (global-stable): base instructions, game systems, chargen rules  [BP1 — 1h]
 *   Tier 2 (session-stable): known players (varies by returning-player set)  [BP2 — 1h]
 *   Tier 3 (randomized per session): shuffled campaign seeds + personalities  [no BP]
 *
 * Tier 3 is intentionally randomized to vary presentation order — we pay
 * fresh input tokens for it, but it's stable across all turns within a
 * single session so the provider's auto-caching still helps after turn 1.
 *
 * BP3 (tools) and BP4 (last message) are stamped via cacheHints in runTurn.
 */
function buildSystemPrompt(
  model: string,
  existingPlayers?: KnownPlayer[],
  userWorldsDir?: string,
  userPersonalitiesDir?: string,
  imageGenSupported?: boolean,
  portraitLoopActive?: boolean,
): SystemBlock[] {
  const blocks: SystemBlock[] = [];

  // ── Tier 1: Global-stable (identical across all sessions) ──

  const base = loadPrompt("setup-conversation", model);
  blocks.push({ text: base });

  // Image-generation consent guidance is conditionally appended ONLY when
  // the active provider/model exposes image generation. Skipping it
  // entirely when unsupported avoids the setup agent asking a question
  // that can't be acted on — and keeps the cached prefix tighter for
  // text-only tiers. The locked phrasing for the question itself is
  // baked into the prompt text below per saved feedback memory.
  if (imageGenSupported) {
    const portraitSection = portraitLoopActive ? [
      "",
      "### Character reference sheet (only when the player said Yes above)",
      "",
      "Once the player has chosen a character name and given you a description, generate a character reference sheet for them. Use the `generate_image` tool — its `prompt` should describe the character's full body once (build, clothing, footwear, mood, expression) and then call for a single side-by-side sheet showing that SAME character from three angles: a front view, a three-quarter view from the front-left, and a three-quarter view from the rear-right, against a plain black background. The extra angles are what stop generated scenes from defaulting to a stiff, camera-facing pose, since this sheet becomes the canonical reference the DM conditions in-game art on. Don't specify an art medium or lighting yourself — the engine renders the character in the campaign's visual style against a plain black background (a clean reference sheet, not a scene), so the character card matches the look the DM will use in play. (It also pins a fixed standard quality and landscape framing — you just write the character.)",
      "",
      "After each draft is rendered, ask the player something light like \"Look right, or do you want me to try again with anything different?\" — don't editorialize about the image yourself. If they want adjustments, call `generate_image` again with a revised prompt. There's no iteration cap; let them iterate until they're happy.",
      "",
      "When the player confirms (or moves on without enthusiasm), call `set_portrait` with the character's name and the latest draft's filename. The filename comes back as the tool result of `generate_image` — record it and pass it through verbatim. Do this BEFORE calling `finalize_setup`.",
      "",
      "If the player said No to images at the consent step above, skip this entire section. Don't generate a reference sheet, don't call set_portrait, just continue with character creation and finalize.",
    ].join("\n") : "";

    blocks.push({
      text: [
        "## Image generation",
        "",
        "After the player has chosen a world (Quick Start) or finished system selection (Full Setup), and BEFORE you ask any character questions, present the image-generation consent question:",
        "",
        "Call `present_choices` with:",
        "  prompt: \"Do you want images in your game? (you can change this in game settings later)\"",
        "  choices: [\"Yes\", \"No\"]",
        "",
        "Pass the player's answer to `finalize_setup` as the `image_generation` field — `\"on\"` if they picked Yes, `\"off\"` if they picked No. If they answer freeform, interpret naturally. Do not editorialize or explain further; the parenthetical in the question already tells the player it's reversible.",
        "",
        "Use the locked phrasing verbatim — do not paraphrase, expand, or add caveats. The choice is reversible (the in-campaign ESC menu has a toggle for it), so don't agonize over it; one quick yes/no.",
        portraitSection,
      ].join("\n"),
    });
  }

  const { light, crunchy } = groupByTier(KNOWN_SYSTEMS);
  const lightList = light.map(formatSystemLine).join("\n");
  const crunchyList = crunchy.map(formatSystemLine).join("\n");

  let systemSection = "\n\n## Available game systems\n\nUse the **slug** (e.g. `dnd-5e`) in `finalize_setup`, not the display name. For pure narrative (no mechanics), pass `null` for system.\n\n";
  systemSection += "### Light systems (simple rules, fast play)\n" + lightList + "\n\n";
  if (crunchy.length > 0) {
    systemSection += "### Crunchy systems (detailed mechanics)\n" + crunchyList + "\n\n";
  }

  // Chargen rules for all systems that have them
  let chargenSection = "## Character creation rules by system\n\nAfter the player picks a system, use the matching section below to ask smart character questions.\n\n";
  for (const sys of KNOWN_SYSTEMS) {
    const section = readChargenSection(sys.slug);
    if (section) {
      chargenSection += `### ${sys.name} (\`${sys.slug}\`)\n${section}\n\n`;
    }
  }

  blocks.push({ text: systemSection + chargenSection });

  // BP1 — stamp on last Tier 1 block (1h, covers base + systems + chargen)
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cacheControl: { ttl: "1h" } };

  // ── Tier 2: Session-stable (varies by returning-player set) ──

  if (existingPlayers && existingPlayers.length > 0) {
    // Sanitize names: single line, no control chars or markup
    const sanitize = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[<>`]/g, "").trim();
    // Cap at 9 to stay within present_choices maxItems (10) with room for edge cases
    const players = existingPlayers.slice(0, 9);
    const playerLines = players.map((p) => {
      const name = sanitize(p.name);
      const age = p.ageGroup ? ` (age group: ${p.ageGroup})` : " (age group: unknown)";
      return `- ${name}${age}`;
    });
    const instruction = "These players have played before. Use `present_choices` at the start to let the player pick their name from this list (the app auto-appends an \"Enter your own\" option for new players). If they match a known player, welcome them back warmly — no need to re-ask information you already have. If their age group is unknown, ask once casually.";
    blocks.push({
      text: "\n\n## Known Players\n\n" + instruction + "\n\n" + playerLines.join("\n"),
      cacheControl: { ttl: "1h" },
    });
  }

  // ── Tier 3: Randomized per session (stable across turns within session) ──

  const worlds = worldSummaries(loadAllWorlds(userWorldsDir));
  const seedList = shuffle(worlds).map((s) => {
    const desc = s.description ? ` | Description: ${s.description}` : "";
    const extra = s.hasDetail ? " [has detail]" : "";
    return `- **${s.name}** (slug: \`${s.slug}\`) — ${s.summary} (${s.genres.join(", ")})${desc}${extra}`;
  }).join("\n");
  const personalities = loadAllPersonalities(userPersonalitiesDir);
  const personalityList = shuffle(personalities).map((p) => {
    const desc = p.description ? `: ${p.description}` : "";
    const detail = p.detail ? `\n  Detail: ${p.detail.replace(/\n/g, "\n  ")}` : "";
    return `- **${p.name}**${desc}${detail}`;
  }).join("\n");

  blocks.push({
    text: "\n\n## Available campaign worlds\n\nUse these when presenting Quick Start options or campaign ideas. Pick worlds that match the player's genre if known. When presenting worlds as choices, use the name as the choice label and the summary (or description if available) as the choice description. For worlds marked [has detail], call `load_world` with the slug to get the full DM detail and any suboptions to present to the player.\n\n" + seedList +
      "\n\n## Available DM personalities\n\nWhen presenting personality choices, use the name as the choice label and the description as the choice description. You can also invent new personalities beyond this list — if a campaign calls for a voice that isn't here, or the player asks for something custom, craft a name and prompt fragment in the same style as the examples below.\n\n" + personalityList,
  });

  return blocks;
}

// Built fresh per session so seed/personality order is randomized.
// Tier 1+2 (base prompt, systems, chargen, known players) are cache-
// stable across turns; Tier 3 (shuffled seeds/personalities) pays fresh
// input tokens on turn 1 but benefits from provider auto-caching after.

// --- Streaming with retry ---

/**
 * Stream an API call with exponential backoff retry on transient errors.
 */
async function streamWithRetry(
  provider: LLMProvider,
  params: ChatParams,
  onDelta: (delta: string) => void,
  onRetry?: (status: number, delayMs: number) => void,
): Promise<ChatResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext("setup", {
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.systemPrompt,
        thinking: params.thinking,
        tools: params.tools,
        messages: params.messages,
      });
      return await provider.stream(params, onDelta);
    } catch (e) {
      const status = extractStatus(e);
      if (status === null || !RETRYABLE_STATUS.has(status)) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      const delay = retryDelay(attempt);
      onRetry?.(status, delay);
      await sleep(delay);
    }
  }
}

// --- Implementation ---

/**
 * Resolve a free-form system string to a known slug.
 * Tries: exact slug match → display name match → slugified match → passthrough.
 */
export function resolveSystemSlug(raw: string): string {
  // Already a known slug?
  if (KNOWN_SYSTEMS.some((s) => s.slug === raw)) return raw;
  // Match by display name (case-insensitive)?
  const byName = KNOWN_SYSTEMS.find(
    (s) => s.name.toLowerCase() === raw.toLowerCase(),
  );
  if (byName) return byName.slug;
  // Fuzzy: slugify the input and check against known slugs
  const slugified = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const bySlugged = KNOWN_SYSTEMS.find((s) => s.slug === slugified);
  if (bySlugged) return bySlugged.slug;
  // Unknown system — return slugified form (user-processed or free-form)
  return slugified || raw;
}

export function createSetupConversation(
  provider: LLMProvider,
  model: string,
  existingPlayers?: KnownPlayer[],
  onRetry?: (status: number, delayMs: number) => void,
  userWorldsDir?: string,
  userPersonalitiesDir?: string,
  /**
   * FileIO + setupRoot enable the portrait loop: drafts land at
   * `<setupRoot>/campaign/images/portrait-draft-*.png` via handleImageGenerated,
   * and set_portrait copies a chosen draft to
   * `<setupRoot>/characters/<slug>-portrait.png`. world-builder picks that
   * up at finalize and copies it into the freshly-scaffolded campaign.
   * When either is absent (e.g. test paths), image-gen tools are not
   * registered and portraits are skipped entirely.
   */
  fileIO?: FileIO,
  setupRoot?: string,
): SetupConversation {
  // Build per-session system prompt (randomizes seed/personality order).
  // Known players are injected right after the base prompt (before seeds/personalities)
  // so the model sees them close to the flow instructions that reference them.
  // imageGenSupported gates the image-consent prompt section so the setup
  // agent doesn't ask the question on text-only tiers.
  const imageGenSupported = provider.getCapabilities?.(model).imageGeneration ?? false;
  /**
   * Full portrait loop requires capability + on-disk scratch space.
   * Test paths typically omit fileIO/setupRoot, so they get the consent
   * question (if imageGenSupported) but no portrait tools — finalize
   * still records the player's preference.
   */
  const portraitLoopActive = imageGenSupported && !!fileIO && !!setupRoot;
  const systemPrompt = buildSystemPrompt(
    model, existingPlayers, userWorldsDir, userPersonalitiesDir,
    imageGenSupported, portraitLoopActive,
  );

  const messages: NormalizedMessage[] = [];
  const totalUsage: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  };

  let finalized: SetupResult | undefined;
  /**
   * The world most recently fetched via `load_world`. Tracked so the chargen
   * portrait can be rendered in that seed's `image_style` (the player loads the
   * world they're interested in before chargen, so by portrait time this is the
   * campaign's seed). Undefined for fully custom campaigns → CinematicFilm
   * fallback. A heuristic, not authoritative: if the player loads several seeds
   * and reconsiders after the portrait, the last-loaded one wins.
   */
  let lastLoadedWorld: WorldFile | undefined;
  // Pending state when present_choices is called — stores tool_use_id so we can send the result back
  let pendingToolUseId: string | null = null;
  // Tool results for tools that ran alongside present_choices (e.g. load_world).
  // They must be flushed with the choice resolution — otherwise their tool_use
  // blocks are left orphaned and Anthropic 400s on the next request.
  let pendingExtraToolResults: ContentPart[] = [];
  /**
   * Active tool list this conversation will offer the model. When the
   * portrait loop is gated on, add generate_image (intercepted by the
   * provider) + set_portrait (dispatched here in runToolDispatch / the
   * legacy loop). When off, only the base tools are exposed so models
   * on text-only tiers don't see calls they can't service.
   */
  const TOOLS: NormalizedTool[] = portraitLoopActive
    ? [...BASE_TOOLS, ...IMAGE_GEN_TOOLS]
    : BASE_TOOLS;

  // Breadcrumb so the harness can confirm setup-agent actually believes it
  // should be doing portraits. If this is false in a live image-gen smoke
  // test, the consent gate or capability detection is the culprit, not
  // the image API.
  logEvent("setup:image_tools_registered", {
    model,
    providerId: provider.providerId,
    // Raw return so we can spot a provider returning a surprising shape
    // (e.g. `imageGeneration: "true"` as a string, or a model-registry
    // fallback path returning true on a provider whose dispatch can't
    // actually serve it).
    rawCapabilities: provider.getCapabilities?.(model),
    hasGenerateImage: typeof provider.generateImage === "function",
    imageGenSupported,
    portraitLoopActive,
    hasFileIO: !!fileIO,
    hasSetupRoot: !!setupRoot,
  });

  /**
   * Drafts persisted during this turn. Lifted into the SetupTurnResult so
   * the caller can broadcast a `display_image` TUI command for each.
   * Reset at the top of runTurn.
   */
  let turnImageDisplays: { filename: string; intent: "character_portrait" }[] = [];

  /**
   * Dispatch a `generate_image` function tool call.
   *
   * Flow: read effort/aspect/prompt from model args → call
   * provider.generateImage → persist bytes to disk via handleImageGenerated
   * → record path for the caller to broadcast as a display_image TUI
   * command → return a text tool_result confirming the image was shown
   * to the player and naming the draft filename so the model can
   * subsequently call set_portrait with the right basename.
   *
   * Errors (no provider support, network failure, content refusal) bubble
   * up as an isError tool_result so the model can apologize or retry.
   */
  async function dispatchGenerateImage(
    callId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    if (!portraitLoopActive || !fileIO || !setupRoot) {
      return { content: "generate_image is not available (portrait loop gated off).", isError: true };
    }
    if (!provider.generateImage) {
      return { content: "The configured provider does not support image generation.", isError: true };
    }
    const promptText = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!promptText) {
      return { content: "generate_image requires a non-empty prompt.", isError: true };
    }
    // Render the reference sheet in the campaign's visual style: the chosen
    // seed's `image_style` stamps the CHARACTER's render treatment, the framing
    // (appended last) keeps the sheet a clean black-background turnaround. The
    // agent writes only the character + three-view text; the engine owns the
    // style + framing ordering — see composeChargenPortraitPrompt, where the
    // ordering IS the fix. Unknown/missing style falls back to the default.
    const styledPrompt = composeChargenPortraitPrompt(promptText, lastLoadedWorld?.image_style);
    try {
      // Chargen has exactly one canonical render config — a standard-effort,
      // landscape multi-angle reference sheet — so we pin both here rather than
      // read them from the model. Tool args aren't enforced server-side (see
      // image-coerce), and a stray `aspect: "portrait"` would collapse the
      // sheet back to a single front pose (defeating the whole point) while a
      // stray `showcase` would block chargen on a slow maximum-fidelity render.
      // That's why the tool no longer exposes either knob.
      const result = await provider.generateImage({
        prompt: styledPrompt,
        effort: "standard",
        aspect: "landscape",
        intent: "character_portrait",
      });
      // Persist via image-handler — shared with the DM-side dispatch in
      // game-engine.ts, so disk naming, sidecar JSON, and downstream
      // consumers (transcript export, world-builder finalize) are uniform
      // across both call sites.
      const persisted = await handleImageGenerated(fileIO, setupRoot, null, {
        id: callId,
        base64: result.base64,
        mimeType: result.mimeType,
        intent: "character_portrait",
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
      });
      const absPath = norm(`${setupRoot}/${persisted.relPath}`);
      turnImageDisplays.push({ filename: absPath, intent: "character_portrait" });
      const basename = persisted.relPath.split("/").pop() ?? "portrait-draft.png";
      return {
        content: `Reference sheet rendered and shown to the player at ${basename} (effort: ${result.effortUsed}, aspect: ${result.aspectUsed}). Now check in with the player about it — and remember the filename if they want to keep this draft via set_portrait.`,
        isError: false,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logEvent("image_gen:dispatch_failed", {
        agent: "setup",
        message: message.slice(0, 400),
      });
      return { content: `Image generation failed: ${message}`, isError: true };
    }
  }

  /**
   * Copy a draft from `<setupRoot>/campaign/images/<draft_filename>` to
   * `<setupRoot>/characters/<slug>-portrait.png`. The world-builder
   * picks up the latter at finalize and ports it into the new campaign.
   * Returns content for the tool_result body.
   */
  async function dispatchSetPortrait(input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (!fileIO || !setupRoot || !fileIO.readBinaryFile || !fileIO.writeBinaryFile) {
      return { content: "set_portrait is not available — fileIO or setupRoot missing.", isError: true };
    }
    const characterName = typeof input.character_name === "string" ? input.character_name.trim() : "";
    const draftFilename = typeof input.draft_filename === "string" ? input.draft_filename.trim() : "";
    if (!characterName || !draftFilename) {
      return { content: "set_portrait requires both character_name and draft_filename.", isError: true };
    }
    // Sanitize the draft filename to a basename — defense against an agent
    // accidentally emitting an absolute or relative path with separators.
    const safeBasename = draftFilename.replace(/[\\/]/g, "").trim();
    if (!safeBasename) {
      return { content: `Invalid draft_filename: ${draftFilename}`, isError: true };
    }
    const srcPath = norm(`${setupRoot}/campaign/images/${safeBasename}`);
    if (!(await fileIO.exists(srcPath))) {
      return { content: `Draft not found: ${safeBasename}`, isError: true };
    }
    const charSlug = slugify(characterName);
    const destPath = norm(campaignPaths(setupRoot).characterPortrait(characterName));
    try {
      const bytes = await fileIO.readBinaryFile(srcPath);
      // Ensure characters/ exists — campaignDirs() created it for the new
      // campaign but the __setup__ scratch tree was minimal at startup.
      await fileIO.mkdir(norm(`${setupRoot}/characters`));
      await fileIO.writeBinaryFile(destPath, bytes);
      return {
        content: `Portrait set for ${characterName} (slug: ${charSlug}). The campaign will use this image when setup completes.`,
        isError: false,
      };
    } catch (e) {
      return {
        content: `Failed to set portrait: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }

  function handleFinalize(input: Record<string, unknown>): void {
    const personalityName = (input.dm_personality as string) || "The Unknown";
    const customPrompt = input.dm_personality_prompt as string | undefined;
    const personality = getPersonality(personalityName, userPersonalitiesDir)
      ?? { name: personalityName, prompt_fragment: customPrompt || `You are ${personalityName}.` };

    const characterName = (input.character_name as string) || "Adventurer";

    // Resolve system to a known slug — the agent should pass a slug, but
    // if it passes a display name (e.g. "D&D 5e") we map it to the slug.
    // Guard against the LLM returning the literal string "null" / "none",
    // possibly with whitespace padding.
    const rawSystem = typeof input.system === "string" ? input.system.trim() : "";
    const normalized = rawSystem.toLowerCase();
    const isNullish = !rawSystem || normalized === "null" || normalized === "none";
    const resolvedSystem = isNullish ? null : resolveSystemSlug(rawSystem);

    // Resolve campaign detail: prefer the agent's passthrough, fall back to world file lookup.
    // Only fall back when the field is truly absent (undefined/null) — an explicit
    // empty string means the agent intentionally omitted it.
    const campaignName = (input.campaign_name as string) || "A New Story";

    // The explicit seed slug the agent passed (came from load_world — reliable).
    // Sanitized to a clean slug to prevent path traversal. Empty when the
    // campaign is fully custom (no world chosen). This is the *only* slug used
    // to materialize a seed's inline content — we never fall back to a
    // campaign-name-derived slug for materialization, which could pull in an
    // unrelated bundled world that happens to share the name.
    const rawWorldSlug = typeof input.world_slug === "string" ? input.world_slug.trim().toLowerCase() : "";
    const worldSlug = rawWorldSlug.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

    // Parse the agent's fork resolutions (forkId → optionId). Validated
    // against the seed's actual forks below before anything is stored.
    const rawForkSel = input.fork_selections;
    let reportedSelections: Record<string, string> | undefined;
    if (rawForkSel && typeof rawForkSel === "object" && !Array.isArray(rawForkSel)) {
      const fs: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawForkSel as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) fs[k] = v.trim();
      }
      if (Object.keys(fs).length) reportedSelections = fs;
    }

    const rawDetail = input.campaign_detail;
    // Trim the agent's detail: when it is appended to a seeded campaign's
    // assembled base, a leading-whitespace/newline `<!--include:...-->` would
    // expand to an INDENTED <TAG>, which applyLayeredOverrides (column-0 only)
    // would miss — silently dropping the intended override. Trimming keeps the
    // appended block flush-left so the override is seen.
    let campaignDetail: string | null = typeof rawDetail === "string" && rawDetail.trim()
      ? rawDetail.trim() : null;

    // For a seeded campaign, code assembles the DM-detail FLOOR from the seed's
    // fork-invariant base plus the *selected* fork branches, so the DM sees one
    // collapsed variant and the unchosen branches never reach its context; the
    // setup agent may then APPEND its own campaign_detail on top (see below).
    // Precedence: an explicit world_slug always assembles from the
    // seed; otherwise (only when the agent supplied no detail) we fall back to
    // a campaign-name-derived slug for back-compat with agents that forget the
    // slug. An agent-supplied detail with no slug = a fully custom campaign.
    const fallbackSlug = campaignName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const seedSlug = worldSlug || (campaignDetail === null ? fallbackSlug : "");
    let forkSelections: Record<string, string> | undefined;
    if (seedSlug) {
      const world = loadWorldBySlug(seedSlug, userWorldsDir);
      if (world) {
        const forks = normalizeForks(world);
        // Keep only selections that name a real fork + a real option of it.
        if (reportedSelections) {
          const valid: Record<string, string> = {};
          for (const fork of forks) {
            const optId = reportedSelections[fork.id];
            if (optId && fork.options.some((o) => o.id === optId)) valid[fork.id] = optId;
          }
          if (Object.keys(valid).length) forkSelections = valid;
        }
        // Append any agent-supplied detail (held in `campaignDetail`) AFTER the
        // seed base, so a setup-time choice (e.g. a chosen visual-style include)
        // overrides a seed default for colliding <Tag> blocks at DM-prompt time.
        const assembled = assembleCampaignDetail(world.detail, forks, forkSelections);
        // The seed's visual style reaches the DM as an Image include in
        // campaign_detail — resolved at DM-prompt time into an <Image> block that
        // overrides the bare default (the campaign_detail slot outranks
        // dm-directives). Validated against a real .mvstyle (resolveImageStyleLine
        // returns null for a bad stem / missing file) so a malformed seed value
        // can't brick every DM turn with an unresolved-include throw — a bogus
        // style just leaves the campaign on the default look. Placed BEFORE the
        // agent's append so a style the setup agent records still wins the
        // <Image> collision (last occurrence in-slot).
        const rawStyle = world.image_style?.trim() ?? "";
        const styleInclude = rawStyle && resolveImageStyleLine(rawStyle)
          ? `<!--include:Image.${rawStyle}-->`
          : null;
        campaignDetail = [assembled, styleInclude, campaignDetail].filter(Boolean).join("\n\n") || null;
      }
    }

    // The setup prompt + tool description document `few-sessions` as the
    // default when the player declines to choose. Apply that default here
    // too so the stored config matches the documented behavior even if the
    // model omits the field or emits an unknown value.
    const rawScope = typeof input.campaign_scope === "string" ? input.campaign_scope.trim() : "";
    const campaignScope: CampaignScope = (CAMPAIGN_SCOPES as readonly string[]).includes(rawScope)
      ? (rawScope as CampaignScope)
      : "few-sessions";

    finalized = {
      genre: (input.genre as string) || "Classic fantasy",
      system: resolvedSystem,
      campaignName,
      campaignPremise: (input.campaign_premise as string) || "An adventure awaits.",
      campaignDetail,
      mood: (input.mood as string) || "Balanced",
      difficulty: (input.difficulty as string) || "Balanced",
      campaignScope,
      personality,
      playerName: (input.player_name as string) || "Player",
      characterName,
      characterDescription: (input.character_description as string) || "",
      characterDetails: (input.character_details as string) || null,
      themeColor: generateThemeColor(characterName),
      ageGroup: (input.age_group as "child" | "teenager" | "adult" | undefined) ?? undefined,
      contentPreferences: (input.content_preferences as string) || undefined,
      imageGeneration: input.image_generation === "on" || input.image_generation === "off"
        ? (input.image_generation as "on" | "off")
        : undefined,
      // Only honored for light/ultra-light systems (the only case the agent is
      // told to ask). Recorded verbatim when the agent reports it; the DM prefix
      // applies MECHANICS_MODE_DEFAULT when a light system runs without a choice.
      mechanicsMode: input.mechanics_mode === "dm-managed" || input.mechanics_mode === "player-facing"
        ? (input.mechanics_mode as MechanicsMode)
        : undefined,
      handoffNote: (typeof input.handoff_note === "string" && input.handoff_note.trim())
        ? input.handoff_note.trim() : undefined,
      openingScene: (typeof input.opening_scene === "string" && input.opening_scene.trim())
        ? input.opening_scene.trim() : undefined,
      worldSlug: worldSlug || undefined,
      forkSelections,
    };
  }

  /**
   * Run one player turn. Makes API calls in a loop, processing tool calls
   * every round, until one of three exit conditions:
   *   1. Model emits `present_choices` — return early with pendingChoices;
   *      app resumes via resolveChoice/send.
   *   2. Round produces no tool calls — turn is done.
   *   3. Hit MAX_ROUNDS — defensive cap to prevent runaway loops.
   *
   * Looping (vs. a single follow-up call) matters because the model legitimately
   * chains tools across rounds: e.g. call `load_world` to fetch suboptions, then
   * call `present_choices` in the next round to show them to the player.
   *
   * Uses deferred tool handling for present_choices (pauses for player input),
   * which doesn't fit runAgentLoop's immediate-tool-result model.
   */
  async function runTurn(onDelta: (delta: string) => void): Promise<SetupTurnResult> {
    finalized = undefined;
    pendingToolUseId = null;
    turnImageDisplays = [];

    const ec = getEffortConfig("setup");
    const thinking = ec.effort ? { effort: ec.effort } : undefined;

    // Cache hints: BP3 on tools (1h — stable tool definitions), BP4 on last
    // message (ephemeral — advances each turn). System prompt BPs are stamped
    // directly on the SystemBlock[] returned by buildSystemPrompt.
    const cacheHints = [
      { target: "tools" as const, ttl: "1h" as const },
      { target: "messages" as const },
    ];

    const MAX_ROUNDS = 4;
    let text = "";

    // Per-turn state set by `dispatchTool` for providers that own tool
    // dispatch internally (openai-chatgpt — codex's `item/tool/call` server
    // requests must be answered synchronously, so we can't wait for the
    // outer loop). Mirrors the bookkeeping the loop body does for legacy
    // providers; consumed after stream() returns.
    let internalDispatchUsed = false;
    let internalPendingChoices: { prompt: string; choices: string[]; descriptions?: string[] } | undefined;
    // tool_result blocks for non-suspending tools dispatched during this turn.
    // Codex handles the dispatch in-band, but we still need to record the
    // results in our normalized history so the next turn's `inject_items`
    // emits a properly-paired `function_call_output` after each `function_call`.
    // Without this, re-injected history has orphan `function_call` items and
    // the model interprets them as aborted calls (e.g. "load_world aborted").
    const internalToolResults: ContentPart[] = [];

    /**
     * Run a single tool call. Returns content for the tool-result body.
     * Used both by the outer loop (for providers that surface
     * `result.toolCalls`) and by the dispatchTool closure on chatParams
     * (for providers that consume them internally). The two paths produce
     * the same side effects: `handleFinalize` fires when finalize_setup
     * lands, `pendingChoices` is captured when present_choices lands, etc.
     */
    async function runToolDispatch(call: { id: string; name: string; input: Record<string, unknown> }): Promise<ToolDispatchOutcome> {
      if (call.name === "generate_image") {
        return dispatchGenerateImage(call.id, call.input);
      }
      if (call.name === "set_portrait") {
        return dispatchSetPortrait(call.input);
      }
      if (call.name === "present_choices") {
        const input = call.input as { prompt?: string; choices?: unknown; descriptions?: unknown };
        const rawChoices = Array.isArray(input.choices) ? input.choices : [];
        const choices = rawChoices.map((c: unknown) => typeof c === "string" ? c : String(c));
        const rawDescs = Array.isArray(input.descriptions) ? input.descriptions : [];
        const descriptions = rawDescs.length > 0
          ? rawDescs.map((d: unknown) => typeof d === "string" ? d : String(d))
          : undefined;
        pendingToolUseId = call.id;
        // present_choices suspends the turn — signal that via pendingChoices so
        // both dispatch paths handle it uniformly (capture the choices, skip the
        // tool_result; it's synthesized later from the player's selection). The
        // content is still returned so codex's in-band server request gets a
        // synchronous reply telling the model to halt.
        return {
          content: "Choices have been presented to the player. End your turn now; you will be re-invoked once they select.",
          isError: false,
          pendingChoices: { prompt: input.prompt ?? "Choose:", choices, descriptions },
        };
      }
      if (call.name === "load_world") {
        const slug = (call.input as { slug?: string }).slug ?? "";
        const world = loadWorldBySlug(slug, userWorldsDir);
        // Remember the seed so the chargen portrait can adopt its visual style.
        if (world) lastLoadedWorld = world;
        const content = world ? renderWorldForAgent(world) : `No world found with slug "${slug}".`;
        return { content, isError: false };
      }
      if (call.name === "roll_dice") {
        return renderRollDice(call.input);
      }
      if (call.name === "finalize_setup") {
        if (call.input._parse_error) {
          return { content: String(call.input._parse_error), isError: true };
        }
        handleFinalize(call.input);
        return {
          content: "Setup finalized. Say a brief farewell (don't narrate on behalf of the DM!) and finish with a separator: `---`",
          isError: false,
        };
      }
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const params: ChatParams = {
        model,
        // Adaptive cap: trust the model's natural ceiling so long
        // `finalize_setup` JSON arguments (handoff_note, world detail
        // passthrough, etc.) don't get truncated mid-emission.
        maxTokens: getMaxOutput(model),
        systemPrompt,
        messages,
        tools: TOOLS,
        thinking,
        cacheHints,
        // Per-call dispatch for providers that own the tool loop internally
        // (openai-chatgpt). Codex sends tool calls as in-band server
        // requests that must be answered synchronously, so we can't let
        // them flow through the outer for-loop the way Anthropic / OpenAI
        // API-key providers do. Other providers ignore this field.
        dispatchTool: async (call) => {
          internalDispatchUsed = true;
          const dispatched = await runToolDispatch({ id: call.id, name: call.name, input: call.input });
          // Record tool_result for non-suspending tools. present_choices
          // suspends instead (pendingChoices set) — its tool_result is
          // synthesized later from the player's selection in resolveChoice/send,
          // so stash the choices for the post-stream codex block and record
          // nothing here.
          if (dispatched.pendingChoices) {
            internalPendingChoices = dispatched.pendingChoices;
          } else {
            internalToolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: dispatched.content,
              ...(dispatched.isError ? { is_error: true } : {}),
            });
          }
          // dispatchTool's contract is { content, isError? }; strip the suspend
          // signal before replying to codex's in-band request.
          return { content: dispatched.content, isError: dispatched.isError };
        },
      };

      const result = await streamWithRetry(provider, params, onDelta, onRetry);
      // Portrait drafts are now persisted directly inside dispatchGenerateImage
      // when the model calls the generate_image function tool — no post-hoc
      // assistantContent scrape needed.

      // Defense-in-depth: a refusal-stop with no usable output is a dead
      // end for setup. The previous behavior (silently continue with
      // empty text) rendered nothing to the player and looked like a
      // hang. The openai-chatgpt provider now throws CodexTurnFailedError
      // on `status: "failed"`, but any provider that legitimately returns
      // `stopReason: "refusal"` (Anthropic content filter, OpenAI
      // content_filter incomplete) would also leave us with no narrative
      // to render — surface it as an error so the session-manager catch
      // can broadcast a user-visible message.
      if (
        result.stopReason === "refusal"
        && !result.text
        && (!result.assistantContent || result.assistantContent.length === 0)
        && (!result.toolCalls || result.toolCalls.length === 0)
      ) {
        throw new Error(
          "Setup agent refused or failed to respond. "
          + "This usually means the configured model rejected the prompt or isn't reachable — "
          + "check the connections menu and try again.",
        );
      }

      // openai-chatgpt path: codex ran the entire multi-round tool loop
      // inside its single stream() call. `runToolDispatch` already
      // captured pendingChoices / fired handleFinalize / etc. Skip the
      // legacy per-tool loop below and either return early (choices) or
      // exit the outer for-loop (model finished).
      if (internalDispatchUsed) {
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
        totalUsage.cacheReadTokens += result.usage.cacheReadTokens;
        totalUsage.cacheCreationTokens += result.usage.cacheCreationTokens;
        totalUsage.reasoningTokens += result.usage.reasoningTokens;
        text += result.text;
        if (result.thinkingText) dumpThinking("setup", round, result.thinkingText);
        messages.push({ role: "assistant", content: result.assistantContent });
        if (internalPendingChoices) {
          // Stash non-suspending tool_results so resolveChoice/send can
          // flush them with the present_choices result. Same mechanism the
          // legacy per-tool loop uses (see below).
          pendingExtraToolResults = internalToolResults;
          return {
            text,
            usage: { ...totalUsage },
            pendingChoices: internalPendingChoices,
            ...(turnImageDisplays.length > 0 ? { imageDisplays: turnImageDisplays } : {}),
          };
        }
        // No suspension: push tool_results as a synthetic user message so the
        // next runTurn's history has function_call_output paired with each
        // function_call. (Codex already saw these in-band, but our normalized
        // history is the source of truth for the *next* thread's injection.)
        if (internalToolResults.length > 0) {
          messages.push({ role: "user", content: internalToolResults });
        }
        break;
      }

      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;
      totalUsage.cacheReadTokens += result.usage.cacheReadTokens;
      totalUsage.cacheCreationTokens += result.usage.cacheCreationTokens;
      totalUsage.reasoningTokens += result.usage.reasoningTokens;

      text += result.text;
      if (result.thinkingText) dumpThinking("setup", round, result.thinkingText);

      // Append assistant message (thinking already stripped by provider)
      messages.push({ role: "assistant", content: result.assistantContent });

      // Process tool calls from this round
      const toolResults: ContentPart[] = [];
      let pendingChoices: { prompt: string; choices: string[]; descriptions?: string[] } | undefined;

      // Dispatch every tool call through the SAME shared dispatcher the codex
      // path uses (runToolDispatch), so each tool body lives in exactly one
      // place. This is what prevents the paths from drifting — previously the
      // load_world / finalize_setup / generate_image bodies were written out a
      // second time here, and a missed branch silently dropped a tool call (the
      // generate_image bug this dedupe closes). present_choices is the one
      // suspending tool: runToolDispatch returns a `pendingChoices` signal and
      // sets pendingToolUseId, and we record NO tool_result for it (it's
      // synthesized from the player's selection in resolveChoice/send). Every
      // other tool returns a uniform { content, isError } body.
      for (const tc of result.toolCalls) {
        const dispatched = await runToolDispatch({ id: tc.id, name: tc.name, input: tc.input });
        if (dispatched.pendingChoices) {
          // Pause and return to the app for player input — don't push a result.
          pendingChoices = dispatched.pendingChoices;
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: dispatched.content,
            ...(dispatched.isError ? { is_error: true } : {}),
          });
        }
      }

      // If we have pending choices, return now — app will call resolveChoice later.
      // Any tool results produced alongside present_choices (e.g. load_world) are
      // stashed so they can be flushed with the eventual choice resolution.
      if (pendingChoices) {
        pendingExtraToolResults = toolResults;
        return {
          text,
          usage: { ...totalUsage },
          pendingChoices,
          ...(turnImageDisplays.length > 0 ? { imageDisplays: turnImageDisplays } : {}),
        };
      }

      // No tool calls → turn is done
      if (toolResults.length === 0) break;

      // Send tool results back and loop for the model's continuation
      messages.push({ role: "user", content: toolResults });
    }

    // Defensive wrap-up: if we exited the loop with the last message being
    // tool_results (i.e. we hit MAX_ROUNDS while the model was still chaining
    // tool calls), do one final tools-disabled API call. Otherwise the next
    // runTurn would push a plain user message on top of an existing one,
    // breaking the role-alternation contract and 400-ing the next request.
    //
    // SKIPPED for the codex internal-dispatch path: codex completes the
    // entire multi-tool turn inside a single stream() call and the model
    // has already produced its final narration. We push internalToolResults
    // as a synthetic user message purely so the *next* runTurn's history
    // injection has function_call_output paired with each function_call —
    // it is NOT a signal that the model still owes us prose. Re-running
    // here would have the model re-narrate (the duplicate-output symptom).
    const last = messages[messages.length - 1];
    if (!internalDispatchUsed
      && last && last.role === "user" && Array.isArray(last.content)
      && last.content.some((c) => (c as { type?: string }).type === "tool_result")) {
      const wrapParams: ChatParams = {
        model,
        maxTokens: getMaxOutput(model),
        systemPrompt,
        messages,
        // No tools — force a text-only response so the model can't extend the chain.
        thinking,
        cacheHints,
      };
      const wrap = await streamWithRetry(provider, wrapParams, onDelta, onRetry);
      totalUsage.inputTokens += wrap.usage.inputTokens;
      totalUsage.outputTokens += wrap.usage.outputTokens;
      totalUsage.cacheReadTokens += wrap.usage.cacheReadTokens;
      totalUsage.cacheCreationTokens += wrap.usage.cacheCreationTokens;
      totalUsage.reasoningTokens += wrap.usage.reasoningTokens;
      text += wrap.text;
      if (wrap.thinkingText) dumpThinking("setup", MAX_ROUNDS, wrap.thinkingText);
      messages.push({ role: "assistant", content: wrap.assistantContent });
    }

    return {
      text,
      usage: { ...totalUsage },
      finalized,
      ...(turnImageDisplays.length > 0 ? { imageDisplays: turnImageDisplays } : {}),
    };
  }

  return {
    async start(onDelta) {
      messages.push({ role: "user", content: "I'd like to set up a new campaign." });
      return runTurn(onDelta);
    },

    async send(text, onDelta) {
      if (pendingToolUseId) {
        // User dismissed the choice modal and typed a free-form response.
        // Still must send a tool_result to satisfy the API contract — and
        // flush any tool_results stashed from co-emitted tools (e.g. load_world)
        // so their tool_use blocks are not orphaned.
        messages.push({
          role: "user",
          content: [
            ...pendingExtraToolResults,
            {
              type: "tool_result" as const,
              tool_use_id: pendingToolUseId,
              content: `The player dismissed the choices and instead wrote: "${text}"`,
            },
          ],
        });
        pendingToolUseId = null;
        pendingExtraToolResults = [];
      } else {
        messages.push({ role: "user", content: text });
      }
      return runTurn(onDelta);
    },

    async resolveChoice(selectedText, onDelta) {
      if (!pendingToolUseId) {
        throw new Error("No pending choice to resolve");
      }

      // Send the player's selection as the tool result, along with any stashed
      // tool_results from tools that ran alongside present_choices.
      messages.push({
        role: "user",
        content: [
          ...pendingExtraToolResults,
          {
            type: "tool_result" as const,
            tool_use_id: pendingToolUseId,
            content: `The player selected: "${selectedText}"`,
          },
        ],
      });
      pendingToolUseId = null;
      pendingExtraToolResults = [];

      return runTurn(onDelta);
    },

    get hasPendingChoice() {
      return pendingToolUseId !== null;
    },
  };
}
