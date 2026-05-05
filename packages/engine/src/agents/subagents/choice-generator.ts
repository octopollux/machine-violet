/**
 * Auto-generates player choices after DM narration.
 *
 * Historically this was a stateless one-shot Haiku call with just the latest
 * DM narration + character name. The session variant ({@link createChoiceGeneratorSession})
 * mirrors the DM main loop: a cached system-prompt prefix (instructions +
 * character sheets), an accumulating user/assistant conversation of prior
 * turns, and a per-turn volatile `<context>` block that is injected into the
 * API message but NOT persisted in the stored conversation. This gives Haiku
 * real continuity across a scene at roughly cache-read prices.
 *
 * The legacy stateless {@link generateChoices} helper is retained for tests
 * and simple one-off use.
 *
 * Explicit DM choices (via the `present_choices` tool) always take precedence
 * over auto-generation — see {@link shouldGenerateChoices}.
 */
import type { LLMProvider, NormalizedMessage, SystemBlock, ChatParams, ChatResult } from "../../providers/types.js";
import type { ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats, ModelId } from "../agent-loop.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { extractStatus, retryDelay, RETRYABLE_STATUS, sleep } from "../../utils/retry.js";

export interface GeneratedChoices extends SubagentResult {
  choices: string[];
}

const SYSTEM_PROMPT = loadPrompt("choice-generator");

/** Per small-tier convention: 6 bullet-prefixed choice lines with room for
 *  bullets, color tags, and a short action phrase fits comfortably here.
 *  Extreme colored outputs might graze the edge; freeform input is always
 *  available as a fallback if a set gets truncated. */
const MAX_OUTPUT_TOKENS = TOKEN_LIMITS.SUBAGENT_SMALL;

/**
 * Should we auto-generate choices for this turn?
 *
 * The "frequency" knob maps to a random probability each turn — configurable
 * from the in-campaign settings menu. "none" is accepted as a legacy alias for
 * "never" so campaigns created before the 5-step scale keep working.
 */
export function shouldGenerateChoices(
  frequency: ChoiceFrequency | "none",
  dmProvidedChoices: boolean,
): boolean {
  // Explicit DM choices always take precedence
  if (dmProvidedChoices) return false;

  switch (frequency) {
    case "always": return true;
    case "often": return Math.random() < 0.75;
    case "sometimes": return Math.random() < 0.5;
    case "rarely": return Math.random() < 0.25;
    case "never": return false;
    case "none": return false; // legacy alias
  }

  // Fail closed for unknown frequency strings (e.g. corrupt override on disk).
  return false;
}

/** Parse the Haiku response into a trimmed, capped choice list. */
function parseChoices(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// Stateless helper (kept for tests and simple one-off callers)
// ---------------------------------------------------------------------------

/**
 * Generate player choices from recent DM narration. Stateless — each call
 * starts from scratch with no cross-turn memory. Prefer
 * {@link createChoiceGeneratorSession} for live gameplay.
 */
export async function generateChoices(
  provider: LLMProvider,
  recentNarration: string,
  characterName: string,
  playerAction: string | undefined,
  model: string,
): Promise<GeneratedChoices> {
  const actionContext = playerAction ? `\n\nPlayer's last action:\n${playerAction}` : "";
  const userMessage = `Character: ${characterName}${actionContext}\n\nDM narration:\n${recentNarration}`;

  const result = await oneShot(
    provider,
    model,
    SYSTEM_PROMPT,
    userMessage,
    250,
    "choice-generator",
  );

  return { ...result, choices: parseChoices(result.text) };
}

// ---------------------------------------------------------------------------
// Accumulating session (the real implementation used in gameplay)
// ---------------------------------------------------------------------------

export interface ChoiceGeneratorSession {
  /**
   * Generate choices for the current turn. The user message sent to Haiku
   * includes a volatile `<context>` block; the stored conversation records
   * only the plain `Player action / DM narration` body (context is ephemeral).
   */
  generate(params: {
    narration: string;
    playerAction: string;
    /** Pre-rendered `<context>…</context>` block; pass an empty string to skip. */
    volatileContext: string;
    activeCharacterName: string;
  }): Promise<GeneratedChoices>;

  /**
   * Reset conversation history — intended for scene transitions. If a prior
   * scene precis is supplied, a single synthetic exchange is seeded so Haiku
   * retains long-range context across the cut.
   */
  reset(priorScenePrecis?: string): void;

  /** Number of accumulated user/assistant exchange pairs. Exposed for tests. */
  getExchangeCount(): number;
}

export interface ChoiceGeneratorSessionOptions {
  provider: LLMProvider;
  /** Haiku (or equivalent small-tier) model id. */
  model: ModelId;
  /** Character sheets (one or more, concatenated markdown). Goes in the cached Tier-2 prefix. */
  characterSheets: string;
  /** Bubbled up from the session manager for transient-retry notifications. */
  onRetry?: (status: number, delayMs: number) => void;
}

/**
 * Build the system prompt as three SystemBlocks:
 *   1. Core instructions from `choice-generator.md`         (1h cache)
 *   2. Party/character sheets                                (1h cache)
 *
 * Tier 3 (volatile context) lives on the current user message, not here.
 */
function buildSystemBlocks(characterSheets: string): SystemBlock[] {
  const trimmed = characterSheets.trim();
  const sheetBlock = trimmed
    ? `\n\n## Character sheets\n\nThese are the PCs whose choices you generate. Refer to their stats, abilities, inventory, and relationships when suggesting actions — their toolkit shapes what's plausible.\n\n${trimmed}`
    : "";

  return [
    { text: SYSTEM_PROMPT, cacheControl: { ttl: "1h" } },
    { text: sheetBlock, cacheControl: { ttl: "1h" } },
  ];
}

/** Compose the plain (persisted) user-message body for a turn. */
function plainTurnBody(activeCharacter: string, playerAction: string, narration: string): string {
  const actionLine = playerAction ? `Player action (${activeCharacter}): ${playerAction}` : `Active character: ${activeCharacter}`;
  return `${actionLine}\n\nDM narration:\n${narration}`;
}

/**
 * Create a long-lived choice-generator session. The returned object
 * accumulates history across `generate()` calls and resets on scene
 * transition.
 */
export function createChoiceGeneratorSession(
  opts: ChoiceGeneratorSessionOptions,
): ChoiceGeneratorSession {
  const provider = opts.provider;
  const model = opts.model;
  const systemBlocks = buildSystemBlocks(opts.characterSheets);

  // Stored conversation — plain user/assistant pairs with NO volatile context.
  // Volatile context is added only to the API message, not to what we persist.
  const stored: NormalizedMessage[] = [];

  async function callHaiku(apiMessages: NormalizedMessage[]): Promise<ChatResult> {
    const params: ChatParams = {
      model,
      systemPrompt: systemBlocks,
      messages: apiMessages,
      maxTokens: MAX_OUTPUT_TOKENS,
      // Cache hints: system prompt blocks are stamped with 1h cache above.
      // On messages, ephemeral ("messages" target) means each call refreshes
      // the last-message breakpoint — subsequent calls hit cached history.
      cacheHints: [{ target: "messages" as const }],
    };

    // Retry on transient provider errors. Uses the same `extractStatus` /
    // `RETRYABLE_STATUS` / `retryDelay` / `sleep` helpers as the main provider
    // loop so network-level failures (status 0) and overload strings (→ 529)
    // get retried consistently with the rest of the engine.
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.chat(params);
      } catch (e) {
        const status = extractStatus(e);
        if (status === null || !RETRYABLE_STATUS.has(status) || attempt >= 4) {
          throw e instanceof Error ? e : new Error(String(e));
        }
        const delay = retryDelay(attempt);
        opts.onRetry?.(status, delay);
        await sleep(delay);
      }
    }
  }

  return {
    async generate({ narration, playerAction, volatileContext, activeCharacterName }) {
      const plainBody = plainTurnBody(activeCharacterName, playerAction, narration);
      const apiBody = volatileContext
        ? `${volatileContext}\n\n${plainBody}`
        : plainBody;

      // Send = stored history + current turn (API-only body with context)
      const apiMessages: NormalizedMessage[] = [
        ...stored,
        { role: "user", content: apiBody },
      ];

      const result = await callHaiku(apiMessages);

      // On success, persist the plain body (no volatile) + the assistant reply.
      stored.push({ role: "user", content: plainBody });
      stored.push({ role: "assistant", content: result.text });

      const usage: UsageStats = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
      };

      return { text: result.text, usage, choices: parseChoices(result.text) };
    },

    reset(priorScenePrecis?: string) {
      stored.length = 0;
      const precis = priorScenePrecis?.trim();
      if (precis) {
        // Seed a synthetic exchange so cross-scene threads carry forward without
        // paying for the full prior-scene history. The assistant ack is cheap
        // (~10 tokens) and keeps the conversation in user/assistant alternation.
        stored.push({
          role: "user",
          content: `[Scene transition. Summary of the prior scene for continuity:]\n${precis}`,
        });
        stored.push({
          role: "assistant",
          content: "Acknowledged. Ready to generate choices for the new scene.",
        });
      }
    },

    getExchangeCount() {
      // Each exchange is a user+assistant pair.
      return Math.floor(stored.length / 2);
    },
  };
}

