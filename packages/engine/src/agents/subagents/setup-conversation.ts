import Anthropic from "@anthropic-ai/sdk";
import type { UsageStats } from "../agent-loop.js";
import type { SubagentResult } from "../subagent.js";
import type { SetupResult } from "../setup-agent.js";
import { generateThemeColor } from "../setup-agent.js";
import { PERSONALITIES } from "../../config/personalities.js";
import { SEEDS } from "../../config/seeds.js";
import { KNOWN_SYSTEMS, readChargenSection } from "../../config/systems.js";
import type { SystemComplexity } from "../../config/systems.js";
import { getModel, getEffortConfig } from "../../config/models.js";
import { accumulateUsage as accRawUsage } from "../../context/usage-helpers.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { dumpContext, dumpThinking } from "../../config/context-dump.js";
import {
  extractStatus,
  RETRYABLE_STATUS,
  retryDelay,
  sleep,
} from "../agent-session.js";

// --- Types ---

export interface SetupTurnResult extends SubagentResult {
  /** Non-null when the agent called finalize_setup */
  finalized?: SetupResult;
  /** Non-null when the agent called present_choices — must be resolved before continuing */
  pendingChoices?: { prompt: string; choices: string[]; descriptions?: string[] };
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
}

// --- Tool definitions ---

const FINALIZE_TOOL: Anthropic.Tool = {
  name: "finalize_setup",
  description:
    "Call this when you have gathered enough information to create the campaign. " +
    "All fields are required. Infer reasonable defaults for anything the player didn't specify.",
  input_schema: {
    type: "object" as const,
    properties: {
      genre: { type: "string", description: "Genre (e.g. 'Classic fantasy', 'Sci-fi', 'Modern supernatural')" },
      system: { type: "string", description: "Game system slug from the available systems list (e.g. 'dnd-5e', 'fate-accelerated'), or null for pure narrative. Use the slug, not the display name.", nullable: true },
      campaign_name: { type: "string", description: "Short evocative campaign title" },
      campaign_premise: { type: "string", description: "One-paragraph campaign hook" },
      mood: { type: "string", description: "Mood (e.g. 'Heroic', 'Grimdark', 'Whimsical', 'Tense')" },
      difficulty: { type: "string", description: "Difficulty ('Gentle', 'Balanced', 'Unforgiving')" },
      dm_personality: { type: "string", description: "DM personality name from the available list, or a custom name if the player described their own" },
      dm_personality_prompt: { type: "string", description: "For custom personalities only: a 2-3 sentence prompt fragment describing the DM's narrative voice and style (e.g. 'You are The Captain. You narrate with dry naval authority...'). Omit when using a personality from the available list." },
      player_name: { type: "string", description: "Player's real name, or 'Player'" },
      character_name: { type: "string", description: "Player character's name" },
      character_description: { type: "string", description: "One-sentence character concept" },
      character_details: { type: "string", description: "Mechanical character details gathered during setup (class, skills, approaches, etc). Free-form text. Omit or null for pure narrative.", nullable: true },
    },
    required: [
      "genre", "campaign_name", "campaign_premise", "mood",
      "difficulty", "dm_personality", "player_name",
      "character_name", "character_description",
    ],
  },
};

const PRESENT_CHOICES_TOOL: Anthropic.Tool = {
  name: "present_choices",
  description:
    "Present the player with a set of structured choices in a selection modal. " +
    "Use this when you want to offer 2-10 concrete options (e.g. genre, character concepts, campaign premises). " +
    "The player's selection will be returned as the tool result. " +
    "You can include a short text message before calling this tool to give context. " +
    "If a choice needs explanation, provide a descriptions array (same length as choices) — " +
    "the description for the highlighted choice is shown in a preview region.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Short prompt shown above the choices (e.g. 'What kind of world?')" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "2-10 short option labels for the player to choose from",
        minItems: 2,
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

const TOOLS = [FINALIZE_TOOL, PRESENT_CHOICES_TOOL];

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

function buildSystemPrompt(): string {
  const base = loadPrompt("setup-conversation");
  const seedList = SEEDS.map((s) => {
    const desc = s.description ? ` | Description: ${s.description}` : "";
    return `- **${s.name}** — ${s.premise} (${s.genres.join(", ")})${desc}`;
  }).join("\n");
  const personalityList = PERSONALITIES.map((p) => {
    const desc = p.description ? `: ${p.description}` : "";
    return `- **${p.name}**${desc}`;
  }).join("\n");

  const { light, crunchy } = groupByTier(KNOWN_SYSTEMS);
  const lightList = light.map(formatSystemLine).join("\n");
  const crunchyList = crunchy.map(formatSystemLine).join("\n");

  let systemSection = "## Available game systems\n\nUse the **slug** (e.g. `dnd-5e`) in `finalize_setup`, not the display name. For pure narrative (no mechanics), pass `null` for system.\n\n";
  systemSection += "### Light systems (simple rules, fast play)\n" + lightList + "\n\n";
  if (crunchy.length > 0) {
    systemSection += "### Crunchy systems (detailed mechanics)\n" + crunchyList + "\n\n";
  }

  // Inject chargen rules for all systems that have them
  let chargenSection = "## Character creation rules by system\n\nAfter the player picks a system, use the matching section below to ask smart character questions.\n\n";
  for (const sys of KNOWN_SYSTEMS) {
    const section = readChargenSection(sys.slug);
    if (section) {
      chargenSection += `### ${sys.name} (\`${sys.slug}\`)\n${section}\n\n`;
    }
  }

  return base +
    "\n\n" + systemSection +
    chargenSection +
    "## Available campaign seeds\n\nUse these when presenting Quick Start options or campaign ideas. Pick seeds that match the player's genre if known. When presenting seeds as choices, use the seed name as the choice label and the premise (or description if available) as the choice description.\n\n" + seedList +
    "\n\n## Available DM personalities\n\nWhen presenting personality choices, use the name as the choice label and the description as the choice description. You can also invent new personalities beyond this list — if a campaign calls for a voice that isn't here, or the player asks for something custom, craft a name and prompt fragment in the same style as the examples below.\n\n" + personalityList;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// --- Streaming with retry ---

/**
 * Stream an API call with exponential backoff retry on transient errors.
 */
async function streamWithRetry(
  client: Anthropic,
  params: Omit<Anthropic.MessageCreateParams, "stream">,
  onDelta: (delta: string) => void,
): Promise<Anthropic.Message> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext("setup", params);
      const stream = client.messages.stream(params);
      stream.on("text", (delta) => { onDelta(delta); });
      return await stream.finalMessage();
    } catch (e) {
      const status = extractStatus(e);
      if (status === null || !RETRYABLE_STATUS.has(status)) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      await sleep(retryDelay(attempt));
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

export function createSetupConversation(client: Anthropic): SetupConversation {
  const messages: Anthropic.MessageParam[] = [];
  const totalUsage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  let finalized: SetupResult | undefined;
  // Pending state when present_choices is called — stores tool_use_id so we can send the result back
  let pendingToolUseId: string | null = null;

  function handleFinalize(input: Record<string, unknown>): void {
    const personalityName = (input.dm_personality as string) || "The Chronicler";
    const customPrompt = input.dm_personality_prompt as string | undefined;
    const personality = PERSONALITIES.find((p) => p.name === personalityName)
      ?? { name: personalityName, prompt_fragment: customPrompt || `You are ${personalityName}.` };

    const characterName = (input.character_name as string) || "Adventurer";

    // Resolve system to a known slug — the agent should pass a slug, but
    // if it passes a display name (e.g. "D&D 5e") we map it to the slug.
    const rawSystem = (input.system as string) || null;
    const resolvedSystem = rawSystem ? resolveSystemSlug(rawSystem) : null;

    finalized = {
      genre: (input.genre as string) || "Classic fantasy",
      system: resolvedSystem,
      campaignName: (input.campaign_name as string) || "A New Story",
      campaignPremise: (input.campaign_premise as string) || "An adventure awaits.",
      mood: (input.mood as string) || "Balanced",
      difficulty: (input.difficulty as string) || "Balanced",
      personality,
      playerName: (input.player_name as string) || "Player",
      characterName,
      characterDescription: (input.character_description as string) || "",
      characterDetails: (input.character_details as string) || null,
      themeColor: generateThemeColor(characterName),
    };
  }

  /**
   * Run one API call, stream text, process tool calls.
   * Returns the result, which may include pendingChoices (needs resolveChoice)
   * or finalized (setup complete).
   *
   * Uses deferred tool handling: present_choices pauses the loop and returns
   * to the app for player input. This pattern doesn't fit runAgentLoop's
   * immediate-tool-result model, so we handle it manually with retry.
   */
  async function runTurn(onDelta: (delta: string) => void): Promise<SetupTurnResult> {
    finalized = undefined;
    pendingToolUseId = null;

    const ec = getEffortConfig("setup");
    const model = getModel("medium");
    const isOpus = model.includes("opus");
    const thinkingParam = ec.effort
      ? { type: "adaptive" as const }
      : { type: "disabled" as const };
    const outputConfig = ec.effort && isOpus ? { effort: ec.effort } : undefined;

    let lastParams = {
      model,
      max_tokens: TOKEN_LIMITS.SUBAGENT_LARGE,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
      thinking: thinkingParam,
      ...(outputConfig ? { output_config: outputConfig } : {}),
    };

    const response = await streamWithRetry(client, lastParams, onDelta);

    accRawUsage(totalUsage, response.usage);

    // Process content blocks
    let text = "";
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let pendingChoices: { prompt: string; choices: string[]; descriptions?: string[] } | undefined;

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "present_choices") {
          // Don't resolve immediately — pause and return to the app for player input
          const input = block.input as { prompt?: string; choices?: unknown; descriptions?: unknown };
          const rawChoices = Array.isArray(input.choices) ? input.choices : [];
          const choices = rawChoices.map((c: unknown) => typeof c === "string" ? c : String(c));
          const rawDescs = Array.isArray(input.descriptions) ? input.descriptions : [];
          const descriptions = rawDescs.length > 0
            ? rawDescs.map((d: unknown) => typeof d === "string" ? d : String(d))
            : undefined;
          pendingChoices = { prompt: input.prompt ?? "Choose:", choices, descriptions };
          pendingToolUseId = block.id;
        } else if (block.name === "finalize_setup") {
          handleFinalize(block.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Setup finalized. Say a brief farewell to the player before the adventure begins.",
          });
        }
      }
    }

    // Dump + strip thinking blocks — they must not be sent back in conversation history
    const thinkingText = response.content
      .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n");
    if (thinkingText) dumpThinking("setup", 0, thinkingText);
    const filtered = response.content.filter((b) => b.type !== "thinking");
    messages.push({ role: "assistant", content: filtered });

    // If we have pending choices, return now — app will call resolveChoice later
    if (pendingChoices) {
      dumpContext("setup", lastParams);
      return {
        text,
        usage: { ...totalUsage },
        pendingChoices,
      };
    }

    // If finalize was called, send tool result and get farewell text
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });

      lastParams = {
        model,
        max_tokens: TOKEN_LIMITS.SUBAGENT_MEDIUM,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        thinking: thinkingParam,
        ...(outputConfig ? { output_config: outputConfig } : {}),
      };
      const followUpMsg = await streamWithRetry(client, lastParams, onDelta);

      accRawUsage(totalUsage, followUpMsg.usage);

      for (const block of followUpMsg.content) {
        if (block.type === "text") {
          text += block.text;
        }
      }

      const followUpThinking = followUpMsg.content
        .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
        .map((b) => b.thinking)
        .join("\n");
      if (followUpThinking) dumpThinking("setup", 1, followUpThinking);
      const filteredFollowUp = followUpMsg.content.filter((b) => b.type !== "thinking");
      messages.push({ role: "assistant", content: filteredFollowUp });
    }

    // Final context dump captures all thinking traces
    dumpContext("setup", lastParams);

    return {
      text,
      usage: { ...totalUsage },
      finalized,
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
        // Still must send a tool_result to satisfy the API contract.
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: pendingToolUseId,
            content: `The player dismissed the choices and instead wrote: "${text}"`,
          }],
        });
        pendingToolUseId = null;
      } else {
        messages.push({ role: "user", content: text });
      }
      return runTurn(onDelta);
    },

    async resolveChoice(selectedText, onDelta) {
      if (!pendingToolUseId) {
        throw new Error("No pending choice to resolve");
      }

      // Send the player's selection as the tool result
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: pendingToolUseId,
          content: `The player selected: "${selectedText}"`,
        }],
      });
      pendingToolUseId = null;

      return runTurn(onDelta);
    },
  };
}
