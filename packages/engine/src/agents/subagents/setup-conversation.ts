import type { SubagentResult } from "../subagent.js";
import type { SetupResult } from "../setup-agent.js";
import { generateThemeColor } from "../setup-agent.js";
import { PERSONALITIES } from "../../config/personalities.js";
import { loadAllWorlds, worldSummaries, loadWorldBySlug } from "../../config/world-loader.js";
import { KNOWN_SYSTEMS, readChargenSection } from "../../config/systems.js";
import type { SystemComplexity } from "../../config/systems.js";
import { getEffortConfig } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
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
  /** True while a present_choices tool call is unresolved — the next user
   *  turn must supply a matching tool_result (either selection or dismissal). */
  readonly hasPendingChoice: boolean;
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
      campaign_detail: { type: "string", description: "The world's hidden detail block (from load_world), passed through verbatim for the DM. Omit if the chosen world has no detail or the campaign is fully custom.", nullable: true },
      world_slug: { type: "string", description: "Slug of the world file used (from load_world). Omit for fully custom campaigns.", nullable: true },
      age_group: { type: "string", enum: ["child", "teenager", "adult"], description: "Player's age group. Set to 'child' or 'teenager' if the player clearly indicates so. Otherwise — including when age is not discussed or the player declines — set to 'adult'. Always include this field." },
      content_preferences: { type: "string", description: "Any content preferences or sensitivities the player mentioned during setup (one per line). Only include if the player volunteered them — never prompt for these.", nullable: true },
      handoff_note: { type: "string", description: "Handoff postcard for the DM's first turn. Free-form prose — the DM sees this once as priming for the opening scene. Include: what the player said about their character IN THEIR OWN WORDS (quote or paraphrase closely, don't sanitize), any freeform remarks they made about the world / tone / things they want or don't want, and anything you (the setup agent) want to pass along to the DM — hooks you promised, tone cues the structured fields don't capture, unresolved ambiguities. Write it as a direct note to the DM, not as narration. A paragraph or two is usually right. Always include this field." },
    },
    required: [
      "genre", "campaign_name", "campaign_premise", "mood",
      "difficulty", "dm_personality", "player_name",
      "character_name", "character_description", "handoff_note",
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
    "Load the full detail and suboptions for a world file by slug. " +
    "Use this when you want to learn more about a specific campaign world " +
    "(e.g., after the player picks one, or to preview its options). " +
    "Returns the world's detail block, suboptions, and any config hints.",
  inputSchema: {
    type: "object" as const,
    properties: {
      slug: { type: "string", description: "The world slug (e.g. 'the-shattered-crown')" },
    },
    required: ["slug"],
  },
};

const TOOLS = [FINALIZE_TOOL, PRESENT_CHOICES_TOOL, LOAD_WORLD_TOOL];

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
function buildSystemPrompt(existingPlayers?: KnownPlayer[]): SystemBlock[] {
  const blocks: SystemBlock[] = [];

  // ── Tier 1: Global-stable (identical across all sessions) ──

  const base = loadPrompt("setup-conversation");
  blocks.push({ text: base });

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

  const worlds = worldSummaries(loadAllWorlds());
  const seedList = shuffle(worlds).map((s) => {
    const desc = s.description ? ` | Description: ${s.description}` : "";
    const extra = s.hasDetail ? " [has detail]" : "";
    return `- **${s.name}** (slug: \`${s.slug}\`) — ${s.summary} (${s.genres.join(", ")})${desc}${extra}`;
  }).join("\n");
  const personalityList = shuffle(PERSONALITIES).map((p) => {
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
): SetupConversation {
  // Build per-session system prompt (randomizes seed/personality order).
  // Known players are injected right after the base prompt (before seeds/personalities)
  // so the model sees them close to the flow instructions that reference them.
  const systemPrompt = buildSystemPrompt(existingPlayers);

  const messages: NormalizedMessage[] = [];
  const totalUsage: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  };

  let finalized: SetupResult | undefined;
  // Pending state when present_choices is called — stores tool_use_id so we can send the result back
  let pendingToolUseId: string | null = null;
  // Tool results for tools that ran alongside present_choices (e.g. load_world).
  // They must be flushed with the choice resolution — otherwise their tool_use
  // blocks are left orphaned and Anthropic 400s on the next request.
  let pendingExtraToolResults: ContentPart[] = [];

  function handleFinalize(input: Record<string, unknown>): void {
    const personalityName = (input.dm_personality as string) || "The Chronicler";
    const customPrompt = input.dm_personality_prompt as string | undefined;
    const personality = PERSONALITIES.find((p) => p.name === personalityName)
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
    const rawDetail = input.campaign_detail;
    let campaignDetail: string | null = typeof rawDetail === "string" && rawDetail.trim()
      ? rawDetail : null;
    if (rawDetail === undefined || rawDetail === null) {
      // Primary: use world_slug if the agent passed it (reliable — came from load_world)
      // Fallback: derive slug from campaign_name (fragile — agent may rename the campaign)
      // Sanitize world_slug to prevent path traversal (strip non-slug chars)
      const rawWorldSlug = typeof input.world_slug === "string" ? input.world_slug.trim().toLowerCase() : "";
      const worldSlug = rawWorldSlug.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const fallbackSlug = campaignName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const slug = worldSlug || fallbackSlug;
      const world = loadWorldBySlug(slug);
      if (world?.detail) campaignDetail = world.detail;
    }

    finalized = {
      genre: (input.genre as string) || "Classic fantasy",
      system: resolvedSystem,
      campaignName,
      campaignPremise: (input.campaign_premise as string) || "An adventure awaits.",
      campaignDetail,
      mood: (input.mood as string) || "Balanced",
      difficulty: (input.difficulty as string) || "Balanced",
      personality,
      playerName: (input.player_name as string) || "Player",
      characterName,
      characterDescription: (input.character_description as string) || "",
      characterDetails: (input.character_details as string) || null,
      themeColor: generateThemeColor(characterName),
      ageGroup: (input.age_group as "child" | "teenager" | "adult" | undefined) ?? undefined,
      contentPreferences: (input.content_preferences as string) || undefined,
      handoffNote: (typeof input.handoff_note === "string" && input.handoff_note.trim())
        ? input.handoff_note.trim() : undefined,
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

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const params: ChatParams = {
        model,
        // First round gets a larger budget for the model's main response;
        // follow-ups (reacting to tool results) are typically shorter.
        maxTokens: round === 0 ? TOKEN_LIMITS.SUBAGENT_LARGE : TOKEN_LIMITS.SUBAGENT_MEDIUM,
        systemPrompt,
        messages,
        tools: TOOLS,
        thinking,
        cacheHints,
      };

      const result = await streamWithRetry(provider, params, onDelta, onRetry);

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

      for (const tc of result.toolCalls) {
        if (tc.name === "present_choices") {
          // Don't resolve immediately — pause and return to the app for player input
          const input = tc.input as { prompt?: string; choices?: unknown; descriptions?: unknown };
          const rawChoices = Array.isArray(input.choices) ? input.choices : [];
          const choices = rawChoices.map((c: unknown) => typeof c === "string" ? c : String(c));
          const rawDescs = Array.isArray(input.descriptions) ? input.descriptions : [];
          const descriptions = rawDescs.length > 0
            ? rawDescs.map((d: unknown) => typeof d === "string" ? d : String(d))
            : undefined;
          pendingChoices = { prompt: input.prompt ?? "Choose:", choices, descriptions };
          pendingToolUseId = tc.id;
        } else if (tc.name === "load_world") {
          const slug = (tc.input as { slug?: string }).slug ?? "";
          const world = loadWorldBySlug(slug);
          let content: string;
          if (world) {
            const parts: string[] = [];
            if (world.detail) parts.push(`## Detail\n${world.detail}`);
            if (world.suboptions?.length) {
              for (const sub of world.suboptions) {
                parts.push(`## Suboption: ${sub.label}\n` +
                  sub.choices.map((c: { name: string; description: string }) => `- **${c.name}** — ${c.description}`).join("\n"));
              }
            }
            if (world.system) parts.push(`Suggested system: ${world.system}`);
            if (world.mood) parts.push(`Suggested mood: ${world.mood}`);
            if (world.difficulty) parts.push(`Suggested difficulty: ${world.difficulty}`);
            content = parts.length > 0 ? parts.join("\n\n") : "World loaded but has no additional detail.";
          } else {
            content = `No world found with slug "${slug}".`;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content,
          });
        } else if (tc.name === "finalize_setup") {
          handleFinalize(tc.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: "Setup finalized. Say a brief farewell (don't narrate on behalf of the DM!) and finish with a separator: `---`",
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
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)
      && last.content.some((c) => (c as { type?: string }).type === "tool_result")) {
      const wrapParams: ChatParams = {
        model,
        maxTokens: TOKEN_LIMITS.SUBAGENT_MEDIUM,
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
