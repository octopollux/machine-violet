import Anthropic from "@anthropic-ai/sdk";
import type { UsageStats } from "../agent-loop.js";
import type { SubagentResult } from "../subagent.js";
import type { SetupResult } from "../setup-agent.js";
import { generateThemeColor } from "../setup-agent.js";
import { PERSONALITIES } from "../../config/personalities.js";
import { getModel, getThinkingConfig } from "../../config/models.js";
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
  pendingChoices?: { prompt: string; choices: string[] };
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
      system: { type: "string", description: "Game system name, or null for pure narrative", nullable: true },
      campaign_name: { type: "string", description: "Short evocative campaign title" },
      campaign_premise: { type: "string", description: "One-paragraph campaign hook" },
      mood: { type: "string", description: "Mood (e.g. 'Heroic', 'Grimdark', 'Whimsical', 'Tense')" },
      difficulty: { type: "string", description: "Difficulty ('Gentle', 'Balanced', 'Unforgiving')" },
      dm_personality: { type: "string", description: "DM personality name (The Chronicler, The Trickster, The Warden, The Bard)" },
      player_name: { type: "string", description: "Player's real name, or 'Player'" },
      character_name: { type: "string", description: "Player character's name" },
      character_description: { type: "string", description: "One-sentence character concept" },
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
    "Use this when you want to offer 2-5 concrete options (e.g. genre, character concepts, campaign premises). " +
    "The player's selection will be returned as the tool result. " +
    "You can include a short text message before calling this tool to give context.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Short prompt shown above the choices (e.g. 'What kind of world?')" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "2-5 option strings for the player to choose from",
        minItems: 2,
        maxItems: 5,
      },
    },
    required: ["prompt", "choices"],
  },
};

const TOOLS = [FINALIZE_TOOL, PRESENT_CHOICES_TOOL];

// --- System prompt ---

const SYSTEM_PROMPT = loadPrompt("setup-conversation");

// --- Streaming with retry ---

/**
 * Stream an API call with exponential backoff retry on transient errors.
 */
async function streamWithRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  onDelta: (delta: string) => void,
): Promise<Anthropic.Message> {
  for (let attempt = 0; ; attempt++) {
    try {
      dumpContext("setup", params);
      const stream = client.messages.stream({ ...params });
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
    const personality = PERSONALITIES.find((p) => p.name === personalityName)
      ?? { name: personalityName, prompt_fragment: `You are ${personalityName}.` };

    const characterName = (input.character_name as string) || "Adventurer";

    finalized = {
      genre: (input.genre as string) || "Classic fantasy",
      system: (input.system as string) || null,
      campaignName: (input.campaign_name as string) || "A New Story",
      campaignPremise: (input.campaign_premise as string) || "An adventure awaits.",
      mood: (input.mood as string) || "Balanced",
      difficulty: (input.difficulty as string) || "Balanced",
      personality,
      playerName: (input.player_name as string) || "Player",
      characterName,
      characterDescription: (input.character_description as string) || "",
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

    const tc = getThinkingConfig("setup");

    const response = await streamWithRetry(client, {
      model: getModel("medium"),
      max_tokens: TOKEN_LIMITS.SUBAGENT_LARGE + tc.budgetTokens,
      system: SYSTEM_PROMPT,
      messages,
      stream: false,
      tools: TOOLS,
      thinking: tc.param,
    }, onDelta);

    accRawUsage(totalUsage, response.usage);

    // Process content blocks
    let text = "";
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let pendingChoices: { prompt: string; choices: string[] } | undefined;

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "present_choices") {
          // Don't resolve immediately — pause and return to the app for player input
          const input = block.input as { prompt?: string; choices?: unknown };
          const rawChoices = Array.isArray(input.choices) ? input.choices : [];
          const choices = rawChoices.map((c: unknown) => typeof c === "string" ? c : String(c));
          pendingChoices = { prompt: input.prompt ?? "Choose:", choices };
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
      return {
        text,
        usage: { ...totalUsage },
        pendingChoices,
      };
    }

    // If finalize was called, send tool result and get farewell text
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });

      const followUpMsg = await streamWithRetry(client, {
        model: getModel("medium"),
        max_tokens: TOKEN_LIMITS.SUBAGENT_MEDIUM + tc.budgetTokens,
        system: SYSTEM_PROMPT,
        messages,
        stream: false,
        tools: TOOLS,
        thinking: tc.param,
      }, onDelta);

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
