import type {
  LLMProvider,
  NormalizedTool,
  NormalizedMessage,
  SystemBlock,
} from "../providers/types.js";
import type { GameState } from "./game-state.js";
import type { FileIO } from "./scene-manager.js";
import type {
  ActionDeclaration,
  ResolutionResult,
  RollRecord,
  TurnSummary,
} from "@machine-violet/shared/types/resolve-session.js";
import { runProviderLoop } from "../providers/agent-loop-bridge.js";
import { parseResolutionXml } from "./resolve-xml.js";
import { rollDice } from "../tools/dice/index.js";
import type { RollDiceInput } from "@machine-violet/shared/types/dice.js";
import { getModel } from "../config/models.js";
import { TOKEN_LIMITS } from "../config/tokens.js";
import { loadPrompt } from "../prompts/load-prompt.js";
import { searchContent } from "./subagents/search-content.js";
import { processingPaths } from "../config/processing-paths.js";
import { norm } from "../utils/paths.js";
import { campaignPaths } from "../tools/filesystem/index.js";

// --- Session tools ---

const SESSION_TOOLS: NormalizedTool[] = [
  {
    name: "roll_dice",
    description: "Roll dice using standard notation. Returns individual rolls and total.",
    inputSchema: {
      type: "object" as const,
      properties: {
        expression: { type: "string", description: "Dice notation, e.g. '1d20+5; 2d6+3'" },
        reason: { type: "string", description: "Why this roll is being made" },
      },
      required: ["expression"],
    },
  },
  {
    name: "read_character_sheet",
    description: "Read a PC's character sheet file (modifiers, features, spell slots, HP).",
    inputSchema: {
      type: "object" as const,
      properties: {
        character: { type: "string", description: "Character name" },
      },
      required: ["character"],
    },
  },
  {
    name: "read_stat_block",
    description: "Read a monster/NPC stat block from the game system content library.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Entity category (e.g. 'monsters', 'npcs')" },
        slug: { type: "string", description: "Entity slug (filename without .md)" },
      },
      required: ["category", "slug"],
    },
  },
  {
    name: "query_rules",
    description: "Look up a specific rule or section from the game system's rule card.",
    inputSchema: {
      type: "object" as const,
      properties: {
        section: { type: "string", description: "Keyword or section heading to search for" },
      },
      required: ["section"],
    },
  },
  {
    name: "search_content",
    description: "LAST RESORT. Search the full content library using a subagent. Prefer the above tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language search query" },
      },
      required: ["query"],
    },
  },
];

// --- ResolveSession ---

/**
 * Persistent resolve session scoped to a combat encounter.
 * Accumulates context across all turns and rounds.
 * Runs at Sonnet tier for complex multi-step mechanical resolution.
 */
export class ResolveSession {
  private provider: LLMProvider;
  private model: string;
  private fileIO: FileIO;
  private gameState: GameState;
  private systemPrompt: SystemBlock[] = [];
  private messages: NormalizedMessage[] = [];
  private turnHistory: TurnSummary[] = [];
  private ruleCardContent = "";
  private currentRound = 1;

  /**
   * @param provider Provider assigned to the medium tier. Combat resolution
   *   needs medium-tier reasoning; passing it explicitly (rather than
   *   defaulting to a tier lookup) lets a heterogeneous-vendor session
   *   route the medium tier through its connection independently of the DM.
   * @param model Model ID for the medium tier; paired with `provider`.
   *   Defaults to `getModel("medium")` for legacy test paths that don't
   *   thread per-tier resolution.
   */
  constructor(provider: LLMProvider, fileIO: FileIO, gameState: GameState, model?: string) {
    this.provider = provider;
    this.model = model ?? getModel("medium");
    this.fileIO = fileIO;
    this.gameState = gameState;
  }

  /**
   * Initialize the session for a combat encounter.
   * Builds the system prompt with rule card and combatant stat blocks.
   */
  async initCombat(
    combatantSheets: string,
    ruleCardCombat: string,
    mapState?: string,
  ): Promise<void> {
    this.ruleCardContent = ruleCardCombat;

    const basePrompt = loadPrompt("resolve-session");

    // Build system prompt as SystemBlock[] for cache breakpoint stamping
    // Block 1: Session identity + output format (stable)
    const block1: SystemBlock = {
      text: basePrompt,
      cacheControl: { ttl: "5m" },
    };

    // Block 2: Rule card combat section (stable for campaign duration)
    const block2: SystemBlock = {
      text: `\n\n## Game Rules (Combat)\n\n${ruleCardCombat}`,
      cacheControl: { ttl: "5m" },
    };

    // Block 3: Combatant stat blocks (stable for combat duration)
    let block3Text = `\n\n## Combatant Sheets\n\n${combatantSheets}`;
    if (mapState) {
      block3Text += `\n\n## Map State\n\n${mapState}`;
    }
    const block3: SystemBlock = {
      text: block3Text,
      cacheControl: { ttl: "5m" },
    };

    this.systemPrompt = [block1, block2, block3];
    this.messages = [];
    this.turnHistory = [];
    this.currentRound = 1;
  }

  /**
   * Resolve a combat action. Accumulates messages across the session.
   * The constructor's `model` is used; the optional argument is kept for
   * call-site overrides (e.g. tests).
   */
  async resolve(action: ActionDeclaration, model?: string): Promise<ResolutionResult> {
    // Track current round from game state
    if (this.gameState.combat.active) {
      this.currentRound = this.gameState.combat.round;
    }

    // Build user message with combat state snapshot + action
    const combatSnapshot = this.buildCombatSnapshot();
    const actionText = this.formatAction(action);
    const userContent = `${combatSnapshot}\n\n${actionText}`;

    this.messages.push({ role: "user", content: userContent });

    // Build tool handler
    const toolHandler = this.buildToolHandler();

    // Run the agent loop with accumulated messages
    const result = await runProviderLoop(
      this.provider,
      this.systemPrompt,
      this.messages,
      {
        name: "resolve_session",
        model: model ?? this.model,
        maxTokens: TOKEN_LIMITS.RESOLVE_SESSION,
        maxToolRounds: 8,
        stream: false,
        tools: [...SESSION_TOOLS],
        toolHandler,
        cacheHints: [{ target: "tools" }],
        effort: null,
      },
    );

    // Append round messages to our persistent messages array
    for (const msg of result.roundMessages) {
      this.messages.push(msg);
    }

    // Parse the resolution XML from the response text
    const parsed = parseResolutionXml(result.text);

    const rolls: RollRecord[] = parsed?.rolls ?? [];
    const resolutionResult: ResolutionResult = {
      narrative: parsed?.narrative ?? result.text,
      deltas: parsed?.deltas ?? [],
      rolls,
      usage: result.usage,
    };

    // Record turn summary
    this.turnHistory.push({
      round: this.currentRound,
      actor: action.actor,
      action: action.action,
      outcome: parsed?.narrative ?? result.text.slice(0, 100),
    });

    return resolutionResult;
  }

  /**
   * Tear down the session and return a combat summary.
   */
  teardown(): string {
    if (this.turnHistory.length === 0) {
      return "Combat ended with no resolved turns.";
    }

    const lines = this.turnHistory.map(
      (t) => `R${t.round}: ${t.actor} — ${t.outcome}`,
    );
    const summary = `Combat summary (${this.turnHistory.length} turns):\n${lines.join("\n")}`;

    // Clear state
    this.messages = [];
    this.turnHistory = [];
    this.systemPrompt = [];

    return summary;
  }

  /** Get current message count (for testing/diagnostics). */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Get turn history (for testing/diagnostics). */
  getTurnHistory(): TurnSummary[] {
    return [...this.turnHistory];
  }

  // --- Private helpers ---

  private buildCombatSnapshot(): string {
    const combat = this.gameState.combat;
    if (!combat.active) {
      return "<combat_state>No active combat.</combat_state>";
    }

    const lines = [`<combat_state>`, `Round: ${combat.round}`];

    // Initiative order with current turn marker
    for (let i = 0; i < combat.order.length; i++) {
      const entry = combat.order[i];
      const marker = i === combat.currentTurn ? " ← CURRENT" : "";
      lines.push(`  ${entry.id} (init ${entry.initiative}, ${entry.type})${marker}`);
    }

    // Turn history summary for context
    if (this.turnHistory.length > 0) {
      lines.push("", "Recent turns:");
      const recent = this.turnHistory.slice(-5);
      for (const t of recent) {
        lines.push(`  R${t.round}: ${t.actor} — ${t.outcome}`);
      }
    }

    lines.push("</combat_state>");
    return lines.join("\n");
  }

  private formatAction(action: ActionDeclaration): string {
    const lines = [
      `<action>`,
      `Actor: ${action.actor}`,
      `Action: ${action.action}`,
    ];
    if (action.targets?.length) {
      lines.push(`Targets: ${action.targets.join(", ")}`);
    }
    if (action.conditions) {
      lines.push(`Conditions: ${action.conditions}`);
    }
    lines.push("</action>");
    return lines.join("\n");
  }

  private buildToolHandler() {
    return async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<{ content: string; is_error?: boolean }> => {
      switch (name) {
        case "roll_dice": {
          const diceInput = input as unknown as RollDiceInput;
          const result = rollDice(diceInput);
          const lines = result.results.map((r) => {
            const kept = r.kept ? r.kept.join(",") : r.rolls.join(",");
            return `${r.expression}: [${kept}]→${r.total}${r.reason ? ` (${r.reason})` : ""}`;
          });
          return { content: lines.join("; ") };
        }

        case "read_character_sheet": {
          const character = input.character as string;
          const paths = campaignPaths(this.gameState.campaignRoot);
          const filePath = norm(paths.character(character));
          try {
            const content = await this.fileIO.readFile(filePath);
            return { content: content || `No character sheet found for ${character}.` };
          } catch {
            return { content: `Character sheet not found: ${character}`, is_error: true };
          }
        }

        case "read_stat_block": {
          const category = input.category as string;
          const slug = input.slug as string;
          const systemSlug = this.gameState.config.system;
          if (!systemSlug) {
            return { content: "No game system configured.", is_error: true };
          }
          const paths = processingPaths(this.gameState.homeDir, systemSlug);
          const entityPath = norm(paths.entityFile(category, slug));
          try {
            const content = await this.fileIO.readFile(entityPath);
            return { content };
          } catch {
            return { content: `Stat block not found: ${category}/${slug}`, is_error: true };
          }
        }

        case "query_rules": {
          const section = (input.section as string).toLowerCase();
          if (!this.ruleCardContent) {
            return { content: "No rule card loaded.", is_error: true };
          }
          // Find matching section by keyword search
          const lines = this.ruleCardContent.split("\n");
          const matches: string[] = [];
          let capturing = false;
          for (const line of lines) {
            if (line.toLowerCase().includes(section)) {
              capturing = true;
            }
            if (capturing) {
              matches.push(line);
              // Stop at next heading or after 50 lines
              if (matches.length > 1 && /^#+\s/.test(line)) {
                matches.pop(); // don't include next heading
                break;
              }
              if (matches.length >= 50) break;
            }
          }
          if (matches.length === 0) {
            return { content: `No rules found matching "${section}".` };
          }
          return { content: matches.join("\n") };
        }

        case "search_content": {
          const query = input.query as string;
          const systemSlug = this.gameState.config.system;
          if (!systemSlug) {
            return { content: "No game system configured.", is_error: true };
          }
          try {
            const result = await searchContent(this.provider, {
              query,
              systemSlug,
              homeDir: this.gameState.homeDir,
            }, this.fileIO);
            return { content: result.text };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: `Content search failed: ${msg}`, is_error: true };
          }
        }

        default:
          return { content: `Unknown tool: ${name}`, is_error: true };
      }
    };
  }
}
