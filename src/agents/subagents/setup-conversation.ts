import Anthropic from "@anthropic-ai/sdk";
import type { UsageStats } from "../agent-loop.js";
import type { SetupResult } from "../setup-agent.js";
import { generateThemeColor } from "../setup-agent.js";
import { PERSONALITIES } from "../../config/personalities.js";
import { getModel } from "../../config/models.js";

// --- Types ---

export interface SetupTurnResult {
  /** Text response from the assistant */
  text: string;
  /** Usage for this turn */
  usage: UsageStats;
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

const SYSTEM_PROMPT = `You are a dramatic master-of-ceremonies introducing a new tabletop RPG campaign. You have flair, gravitas, and showmanship, and you know when to pause and let the moment just... breathe. Your job is to help the player build their campaign.

You need to establish:
1. **Genre/setting** — What kind of world? (fantasy, sci-fi, modern supernatural, post-apocalyptic, or anything)
2. **Campaign concept** — A compelling premise and name for the adventure
3. **Mood** — Heroic, grimdark, whimsical, tense, or a mix
4. **Difficulty** — How forgiving: gentle, balanced, or unforgiving
5. **DM personality** — Who runs the game: The Chronicler (atmospheric, layered), The Trickster (surprising, improbable), The Warden (fair but harsh), or The Bard (character-focused, emotional)
6. **Character** — Name and a one-sentence concept for the player character
7. **Player name** — The human's real name (or just "Player"). Ask for this AFTER the character — something like "And what should I call *you*, the person behind the character?" Players expect to name their character first; asking for their real name first confuses them.
8. **Game system** — Pure narrative (no mechanics), or a light system like FATE Accelerated or 24XX

You have two tools:
- **present_choices** — Shows the player a selection modal with 2-5 options. Use this for key decisions like genre, DM personality, or character selection. The player picks one and their choice comes back to you. You can mix freeform conversation with structured choices.
- **finalize_setup** — Call when you have everything needed to create the campaign.

## Text formatting

You can use these HTML-like tags in your messages for dramatic effect and visual structure:
- <b>bold</b> — for emphasis, key terms, dramatic moments
- <i>italic</i> — for flavor text, whispered asides, evocative descriptions
- <u>underline</u> — for important names or titles
- <color=#HEX>colored text</color> — for thematic color (e.g. <color=#cc0000>blood red</color>, <color=#4488ff>arcane blue</color>, <color=#44cc44>verdant green</color>)
- <center>centered text</center> — for titles, dramatic reveals, section headers

Use formatting to create visual rhythm and break up walls of text. A strategically-placed newline, a bold campaign title, a colored genre tag, an italic atmospheric line — these make the experience feel polished rather than like reading a paragraph.

## Output structure

CRITICAL: Use blank lines between paragraphs and sections. Never write more than 2-3 sentences in a row without a blank line. Short paragraphs (1-2 sentences each) separated by blank lines are far easier to read than a dense block. When in doubt, add a blank line.

## Guidelines
- Be theatrical and enthusiastic, not robotic. You're opening night, not a form wizard.
- Keep messages punchy and structured — short paragraphs, not dense blocks. Use formatting to create breathing room.
- Ask 1-2 questions at a time, not a checklist.
- Use present_choices for big decisions — it's easier for the player to pick from a curated list than type out "post-apocalyptic grimdark". But don't overuse it; freeform answers are great for character concepts and naming.
- Build on the player's ideas. If they mention a vague concept, flesh it out with them.
- If the player gives you a lot at once (e.g. "dark fantasy with a rogue"), run with it — fill in the gaps yourself and propose a complete picture.
- A few exchanges is ideal — 3-5 back-and-forths. But each message should breathe; cover only 1-2 topics per turn rather than cramming everything in.
- When you have enough to work with, call finalize_setup. You don't need explicit confirmation for every detail.
- Default to "pure narrative" (no system) unless the player asks for mechanics.
- Default difficulty is "Balanced" unless the player signals otherwise.

Start with a dramatic welcome — you're opening the curtain on a new adventure. Then ask what kind of world excites them, using present_choices to offer genre options.`;

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

  function accumulateUsage(response: Anthropic.Message): void {
    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;
    const u = response.usage as Record<string, number>;
    totalUsage.cacheReadTokens += u["cache_read_input_tokens"] ?? 0;
    totalUsage.cacheCreationTokens += u["cache_creation_input_tokens"] ?? 0;
  }

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
   */
  async function runTurn(onDelta: (delta: string) => void): Promise<SetupTurnResult> {
    finalized = undefined;
    pendingToolUseId = null;

    const stream = client.messages.stream({
      model: getModel("medium"),
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });

    stream.on("text", (delta) => {
      onDelta(delta);
    });

    const response = await stream.finalMessage();
    accumulateUsage(response);

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
          const input = block.input as { prompt: string; choices: string[] };
          pendingChoices = { prompt: input.prompt, choices: input.choices };
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

    messages.push({ role: "assistant", content: response.content });

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

      const followUp = client.messages.stream({
        model: getModel("medium"),
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      });

      followUp.on("text", (delta) => {
        onDelta(delta);
      });

      const followUpMsg = await followUp.finalMessage();
      accumulateUsage(followUpMsg);

      for (const block of followUpMsg.content) {
        if (block.type === "text") {
          text += block.text;
        }
      }

      messages.push({ role: "assistant", content: followUpMsg.content });
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
      messages.push({ role: "user", content: text });
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
