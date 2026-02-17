import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { agentLoopStreaming } from "./agent-loop.js";
import type { AgentLoopConfig, TuiCommand, UsageStats } from "./agent-loop.js";
import { ConversationManager } from "../context/conversation.js";
import type { DroppedExchange } from "../context/conversation.js";
import { SceneManager } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import { getModel } from "../config/models.js";

// --- Types ---

export type EngineState =
  | "idle"
  | "waiting_input"
  | "dm_thinking"
  | "tool_running"
  | "scene_transition"
  | "session_ending";

export interface EngineCallbacks {
  /** DM text streams in as it generates */
  onNarrativeDelta: (delta: string) => void;
  /** DM finished responding — full text available */
  onNarrativeComplete: (text: string) => void;
  /** Engine state changed (for activity indicators) */
  onStateChange: (state: EngineState) => void;
  /** TUI command from a tool call */
  onTuiCommand: (command: TuiCommand) => void;
  /** Tool started executing */
  onToolStart: (name: string) => void;
  /** Tool finished executing */
  onToolEnd: (name: string) => void;
  /** Exchange dropped from conversation (precis will update) */
  onExchangeDropped: () => void;
  /** Usage stats updated */
  onUsageUpdate: (session: UsageStats) => void;
  /** Error occurred */
  onError: (error: Error) => void;
  /** API call is being retried after a retryable error */
  onRetry: (status: number, delayMs: number) => void;
}

/**
 * The game engine — orchestrates the DM agent, tools, TUI, and scene management.
 * This is the master state machine that drives gameplay.
 */
export class GameEngine {
  private client: Anthropic;
  private registry: ToolRegistry;
  private gameState: GameState;
  private conversation: ConversationManager;
  private sceneManager: SceneManager;
  private callbacks: EngineCallbacks;
  private engineState: EngineState = "idle";
  private sessionUsage: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  };
  private model: AgentLoopConfig["model"];

  constructor(params: {
    client: Anthropic;
    gameState: GameState;
    scene: SceneState;
    sessionState: DMSessionState;
    fileIO: FileIO;
    callbacks: EngineCallbacks;
    model?: AgentLoopConfig["model"];
  }) {
    this.client = params.client;
    this.registry = new ToolRegistry();
    this.gameState = params.gameState;
    this.conversation = new ConversationManager(params.gameState.config.context);
    this.sceneManager = new SceneManager(
      params.gameState,
      params.scene,
      this.conversation,
      params.sessionState,
      params.fileIO,
    );
    this.callbacks = params.callbacks;
    this.model = params.model ?? getModel("large");
  }

  /** Get current engine state */
  getState(): EngineState {
    return this.engineState;
  }

  /** Get session usage stats */
  getSessionUsage(): UsageStats {
    return { ...this.sessionUsage };
  }

  /** Get scene manager (for shutdown transcript flush) */
  getSceneManager(): SceneManager {
    return this.sceneManager;
  }

  /**
   * Process player input: send to DM, stream response, handle tools.
   * This is the main game loop entry point.
   */
  async processInput(characterName: string, text: string): Promise<void> {
    if (this.engineState !== "idle" && this.engineState !== "waiting_input") {
      return; // Already processing
    }

    this.setState("dm_thinking");

    // Tag the input with character name
    const taggedInput = `[${characterName}] ${text}`;

    // Append to transcript
    this.sceneManager.appendPlayerInput(characterName, text);

    // Build the user message
    const userMessage: Anthropic.MessageParam = {
      role: "user",
      content: taggedInput,
    };

    // Get system prompt
    const systemPrompt = this.sceneManager.getSystemPrompt();

    // Get conversation messages + new user message
    const messages = [...this.conversation.getMessages(), userMessage];

    try {
      // Run the agent loop with streaming
      const result = await agentLoopStreaming(
        this.client,
        systemPrompt,
        messages,
        this.registry,
        this.gameState,
        this.buildAgentConfig(),
      );

      // Append to transcript
      if (result.text) {
        this.sceneManager.appendDMResponse(result.text);
      }

      // Add exchange to conversation manager
      const assistantMessage: Anthropic.MessageParam = {
        role: "assistant",
        content: result.text,
      };
      const dropped = this.conversation.addExchange(userMessage, assistantMessage);

      // Handle dropped exchange
      if (dropped) {
        this.callbacks.onExchangeDropped();
        await this.handleDroppedExchange(dropped);
      }

      // Process TUI commands
      for (const cmd of result.tuiCommands) {
        this.callbacks.onTuiCommand(cmd);
      }

      // Accumulate usage
      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

      // Notify completion
      this.callbacks.onNarrativeComplete(result.text);

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.callbacks.onError(error);
    }

    this.setState("waiting_input");
  }

  /**
   * Execute a scene transition.
   */
  async transitionScene(title: string, timeAdvance?: number): Promise<void> {
    this.setState("scene_transition");

    try {
      const result = await this.sceneManager.sceneTransition(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.callbacks.onError(error);
    }

    this.setState("waiting_input");
  }

  /**
   * End the session.
   */
  async endSession(title: string, timeAdvance?: number): Promise<void> {
    this.setState("session_ending");

    try {
      const result = await this.sceneManager.sessionEnd(
        this.client,
        title,
        timeAdvance,
      );

      accUsage(this.sessionUsage, result.usage);
      this.callbacks.onUsageUpdate(this.sessionUsage);

    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.callbacks.onError(error);
    }

    this.setState("idle");
  }

  /**
   * Resume a session.
   */
  async resumeSession(): Promise<string> {
    const recap = await this.sceneManager.sessionResume();
    this.setState("waiting_input");
    return recap;
  }

  // --- Internal ---

  private setState(state: EngineState): void {
    this.engineState = state;
    this.callbacks.onStateChange(state);
  }

  private buildAgentConfig(): AgentLoopConfig {
    return {
      model: this.model,
      maxTokens: 1024,
      maxToolRounds: 10,
      onTextDelta: (delta) => this.callbacks.onNarrativeDelta(delta),
      onToolStart: (name) => {
        this.setState("tool_running");
        this.callbacks.onToolStart(name);
      },
      onToolEnd: (name) => {
        this.setState("dm_thinking");
        this.callbacks.onToolEnd(name);
      },
      onRetry: (status, delayMs) => {
        this.callbacks.onRetry(status, delayMs);
      },
    };
  }

  private async handleDroppedExchange(dropped: DroppedExchange): Promise<void> {
    try {
      const usage = await this.sceneManager.handleDroppedExchange(
        this.client,
        dropped,
      );
      accUsage(this.sessionUsage, usage);
    } catch {
      // Non-critical — precis update failure doesn't break gameplay
    }
  }
}

function accUsage(total: UsageStats, add: UsageStats): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cacheReadTokens += add.cacheReadTokens;
  total.cacheCreationTokens += add.cacheCreationTokens;
}
