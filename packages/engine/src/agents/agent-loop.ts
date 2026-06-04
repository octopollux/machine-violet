import type { ToolRegistry, ToolResult } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { runProviderLoop } from "../providers/agent-loop-bridge.js";
import type { LLMProvider, NormalizedMessage, NormalizedTool, SystemBlock } from "../providers/types.js";
import { GENERATE_IMAGE_TOOL_NAME } from "../providers/types.js";

// --- TUI tools ---

export const TUI_TOOLS = new Set([
  "update_modeline",
  "set_theme",
  "style_scene",
  "set_display_resources",
  "set_resource_values",
  "present_choices",
  "show_character_sheet",
  "enter_ooc",
  "scene_transition",
  "session_end",
  "scribe",
  "dm_notes",
  "promote_character",
  // generate_image returns `_tui: { type: "display_image", ... }` on the
  // ToolResult so the image broadcasts mid-turn (see GameEngine.dispatchGenerateImage).
  // Without this entry the bridge skips _tui extraction entirely — the bytes
  // still land on disk, but the client never receives display_image and the
  // image silently fails to render in the TUI.
  "generate_image",
]);

/** Tools registered in the ToolRegistry but only exposed to OOC / Dev Mode agents. */
const DM_EXCLUDED_TOOLS = new Set(["show_character_sheet", "rollback"]);

// --- Types (canonical definitions) ---

export type ModelId = string;

export interface AgentLoopConfig {
  model: ModelId;
  /** LLM provider to use. */
  provider: LLMProvider;
  maxTokens: number;
  maxToolRounds: number;
  /** Effort level. Omit to auto-resolve from agent name. */
  effort?: import("../config/models.js").EffortLevel | null;
  /** Async tool handler override. Called before registry dispatch.
   *  Return a ToolResult to handle the tool, or null to fall through to registry. */
  asyncToolHandler?: (name: string, input: Record<string, unknown>) => Promise<ToolResult | null>;
  /** Called when DM text streams in */
  onTextDelta?: (delta: string) => void;
  /** Called immediately when a non-deferred TUI command is extracted from a tool result */
  onTuiCommand?: (cmd: TuiCommand) => void;
  /** Called when a tool call starts */
  onToolStart?: (name: string) => void;
  /** Called when a tool call completes */
  onToolEnd?: (name: string, result: ToolResult) => void;
  /** Called when the full response is complete */
  onComplete?: (usage: UsageStats) => void;
  /**
   * When true, append the `generate_image` function tool to the DM's
   * tool list. The model invokes it like any other tool; the host's
   * asyncToolHandler dispatches the call to `provider.generateImage`,
   * persists the bytes, and broadcasts a `display_image` TUI command.
   * Caller is responsible for verifying both `provider.getCapabilities
   * (model).imageGeneration` AND the campaign preference before
   * flipping this on — the agent loop trusts the flag verbatim.
   */
  imageGenEnabled?: boolean;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Called when a retryable API error triggers a backoff wait */
  onRetry?: (status: number, delayMs: number) => void;
  /** Called when a streaming attempt fails after emitting partial deltas — consumers should discard that leaked output before the retry begins. */
  onRollback?: () => void;
}

import type { UsageStats, TuiCommand } from "@machine-violet/shared/types/engine.js";
export type { UsageStats, TuiCommand } from "@machine-violet/shared/types/engine.js";

export interface AgentLoopResult {
  /** Text content from the assistant's final response */
  text: string;
  /** TUI commands emitted by tool calls */
  tuiCommands: TuiCommand[];
  /** Total usage across all rounds */
  usage: UsageStats;
  /** Whether the loop was cut short by maxToolRounds */
  truncated: boolean;
  /**
   * The complete turn as one canonical, self-consistent message sequence
   * (see `normalizeTurn`): `assistant([…, tool_use*])` → `user([tool_result*])`
   * pairs ending in an `assistant` message whose content is the narration.
   * Provider-agnostic and always ends on an assistant message — the engine
   * stores it verbatim without inspecting its shape.
   */
  turnMessages: NormalizedMessage[];
}

// --- Agent Loop ---

/**
 * Run one turn of the agent loop: send messages, stream response,
 * handle tool_use blocks, loop until end_turn or max rounds.
 */
export async function agentLoop(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  return runAgentLoopInternal(provider, systemPrompt, messages, registry, gameState, config, false);
}

// --- Streaming variant ---

/**
 * Run one turn of the agent loop with streaming.
 * Text deltas are emitted via onTextDelta as they arrive.
 */
export async function agentLoopStreaming(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  return runAgentLoopInternal(provider, systemPrompt, messages, registry, gameState, config, true);
}

// --- Internal ---

async function runAgentLoopInternal(
  provider: LLMProvider,
  systemPrompt: string | SystemBlock[],
  messages: NormalizedMessage[],
  registry: ToolRegistry,
  gameState: GameState,
  config: AgentLoopConfig,
  stream: boolean,
): Promise<AgentLoopResult> {
  const asyncHandler = config.asyncToolHandler;
  const toolHandler = asyncHandler
    ? async (name: string, input: Record<string, unknown>) => (await asyncHandler(name, input)) ?? registry.dispatch(gameState, name, input)
    : (name: string, input: Record<string, unknown>) => registry.dispatch(gameState, name, input);

  // Tool list: registry definitions (minus DM_EXCLUDED_TOOLS), plus the
  // `generate_image` function tool when image generation is gated on.
  // The DM's asyncToolHandler (GameEngine.dispatchGenerateImage) routes
  // the call through provider.generateImage and emits the display_image
  // TUI command + bytes-on-disk side effects.
  const tools: NormalizedTool[] = registry.getDefinitions(DM_EXCLUDED_TOOLS);
  if (config.imageGenEnabled) {
    tools.push({
      name: GENERATE_IMAGE_TOOL_NAME,
      description:
        "Generate one illustrated image rendered inline with this response. " +
        "Provide a vivid descriptive prompt covering subject, composition, mood, " +
        "and style. The caption (if any) should be composed into the image itself " +
        "as a printed plate, not emitted as separate text. Use sparingly — at most " +
        "one image per turn. " +
        "Default to `effort: \"standard\"` for ordinary scene snapshots. Reach for " +
        "`effort: \"quality\"` or `\"showcase\"` only for once-per-arc set-pieces; " +
        "they take longer and cost more. Use `aspect: \"landscape\"` for scenes, " +
        "`\"portrait\"` for character close-ups, `\"square\"` for objects/symbols. " +
        "Set `intent` to `\"scene_snapshot\"` for scenes (the usual case), " +
        "`\"character_portrait\"` for character close-ups, or `\"player_request\"` " +
        "when the player explicitly asked for an illustration of something. The " +
        "intent steers on-disk naming and the engine-log breadcrumb — it does not " +
        "affect the rendered image.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Vivid description of the image to render, including any in-image caption text.",
          },
          effort: {
            type: "string",
            enum: ["draft", "standard", "quality", "showcase"],
            description: "Render effort. Default 'standard'. 'showcase' for once-per-arc moments only.",
          },
          aspect: {
            type: "string",
            enum: ["portrait", "landscape", "square"],
            description: "Aspect ratio. Match to the subject: landscape for scenes, portrait for characters, square for objects.",
          },
          intent: {
            type: "string",
            enum: ["scene_snapshot", "player_request", "character_portrait"],
            description: "Steers on-disk naming and the engine-log breadcrumb. 'scene_snapshot' is the right default for in-narrative renders. Omit to default to scene_snapshot.",
          },
        },
        required: ["prompt", "effort", "aspect"],
      },
    });
  }

  const result = await runProviderLoop(provider, systemPrompt, messages, {
    name: "dm",
    model: config.model,
    maxTokens: config.maxTokens,
    maxToolRounds: config.maxToolRounds,
    effort: config.effort,
    stream,
    tools,
    toolHandler,
    cacheHints: [{ target: "tools", ttl: "1h" }, { target: "messages" }],
    tuiToolNames: TUI_TOOLS,
    onTuiCommand: config.onTuiCommand,
    onTextDelta: config.onTextDelta,
    onToolStart: config.onToolStart,
    onToolEnd: config.onToolEnd,
    onComplete: config.onComplete,
    onError: config.onError,
    onRetry: config.onRetry,
    onRollback: config.onRollback,
  });

  return {
    text: result.text,
    tuiCommands: result.tuiCommands,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
    },
    truncated: result.truncated,
    turnMessages: result.turnMessages,
  };
}
