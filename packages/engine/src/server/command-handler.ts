/**
 * Server-side slash command handler.
 *
 * Dispatches slash commands to engine methods and sends results
 * back via WebSocket (narrative:chunk for system messages).
 */
import type { ServerEvent } from "@machine-violet/shared";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "@machine-violet/shared/types/engine.js";
import { queryCommitLog, performRollback } from "../tools/git/index.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";
import type { EndSessionReason } from "./session-manager.js";

export interface CommandResult {
  message?: string;
  error?: boolean;
  endSession?: boolean;
  /** Reason to pass to sessionManager.endSession — e.g. "rollback" skips
   *  the final flush+checkpoint that would otherwise clobber disk with
   *  stale in-memory state. */
  endSessionReason?: EndSessionReason;
}

export async function handleCommand(
  name: string,
  args: string,
  engine: GameEngine,
  gameState: GameState,
  broadcast: (event: ServerEvent) => void,
): Promise<CommandResult> {
  switch (name) {
    case "save":
      return handleSave(args, engine);
    case "log":
      return handleLog(args, engine);
    case "rollback":
      return handleRollback(args, engine, gameState);
    case "retry":
      return handleRetry(engine);
    case "scene":
      return handleScene(args, engine);
    case "ooc":
    case "dm":
      return handleModeToggle("ooc", engine, gameState, broadcast);
    case "dev":
      return handleModeToggle("dev", engine, gameState, broadcast);
    case "exit_mode":
      return handleExitMode(engine, broadcast);
    case "snapshot":
      return handleSnapshot();
    default:
      return { message: `Unknown server command: /${name}`, error: true };
  }
}

async function handleSave(args: string, engine: GameEngine): Promise<CommandResult> {
  const repo = engine.getRepo();
  if (!repo || !repo.isEnabled()) {
    return { message: "Save unavailable — git is disabled." };
  }
  const label = args.trim() || "manual save";
  const oid = await repo.checkpoint(label);
  if (oid) {
    return { message: `Saved: ${oid.slice(0, 7)} — ${label}` };
  }
  return { message: "No changes to save." };
}

async function handleLog(args: string, engine: GameEngine): Promise<CommandResult> {
  const repo = engine.getRepo();
  if (!repo || !repo.isEnabled()) {
    return { message: "Log unavailable — git is disabled." };
  }
  const depth = args.trim() ? parseInt(args.trim(), 10) : undefined;
  if (depth !== undefined && (isNaN(depth) || depth < 1)) {
    return { message: "Usage: /log [depth] — depth must be a positive number", error: true };
  }
  const result = await queryCommitLog(repo, { depth });
  return { message: result };
}

async function handleRollback(args: string, engine: GameEngine, gameState: GameState): Promise<CommandResult> {
  const n = parseInt(args.trim(), 10);
  if (!args.trim() || isNaN(n) || n < 1) {
    return { message: "Usage: /rollback <N> — N = number of exchanges to undo", error: true };
  }
  const repo = engine.getRepo();
  if (!repo || !repo.isEnabled()) {
    return { message: "Rollback unavailable — git is disabled." };
  }
  const fileIO = engine.getSceneManager().getFileIO();
  const result = await performRollback(repo, `exchanges_ago:${n}`, gameState.campaignRoot, fileIO);
  return {
    message: `Rolled back ${n} exchange(s): ${result.summary}`,
    endSession: true,
    endSessionReason: "rollback",
  };
}

function handleRetry(engine: GameEngine): CommandResult {
  if (engine.hasPendingRetry()) {
    engine.retryLastTurn();
    return { message: "Retrying last failed turn..." };
  }
  const ok = engine.retryLastExchange();
  if (!ok) {
    return { message: "Nothing to retry — no conversation history." };
  }
  return { message: "Retrying last turn..." };
}

async function handleScene(args: string, engine: GameEngine): Promise<CommandResult> {
  const title = args.trim();
  if (!title) {
    return { message: "Usage: /scene <title>", error: true };
  }
  await engine.transitionScene(title);
  return { message: `Transitioning: ${title}` };
}

/**
 * Toggle a mode session (OOC or Dev). If already in that mode, exit it.
 * If in a different mode, exit first then enter the new one.
 */
function handleModeToggle(
  target: "ooc" | "dev",
  engine: GameEngine,
  gameState: GameState,
  broadcast: (event: ServerEvent) => void,
): CommandResult {
  const current = engine.getModeSession();

  // If already in the target mode, toggle off
  if (current && current.label.toLowerCase() === target) {
    return handleExitMode(engine, broadcast);
  }

  // If in a different mode, exit first
  if (current) {
    handleExitMode(engine, broadcast);
  }

  // Capture current variant before entering mode
  const previousVariant = engine.getPreviousVariant() ?? "exploration";

  if (target === "ooc") {
    const sm = engine.getSceneManager();
    const session = createOOCSession(engine.getProvider(), {
      campaignName: gameState.config.name,
      previousVariant,
      config: gameState.config,
      sessionState: sm.getSessionState(),
      repo: engine.getRepo() ?? undefined,
      fileIO: sm.getFileIO(),
      campaignRoot: gameState.campaignRoot,
    });
    engine.setModeSession(session);
  } else {
    const session = createDevSession(engine.getProvider(), {
      campaignName: gameState.config.name,
      gameStateSummary: summarizeGameState(gameState),
      gameState,
      fileIO: engine.getSceneManager().getFileIO(),
      sceneManager: engine.getSceneManager(),
      repo: engine.getRepo() ?? undefined,
    });
    engine.setModeSession(session);
  }

  broadcast({
    type: "session:mode",
    data: { mode: target, variant: target },
  });

  const label = target === "ooc" ? "OOC" : "Dev";
  return { message: `${label} Mode — type to chat, ESC to exit` };
}

/**
 * Exit the current mode session and return to normal play.
 */
function handleExitMode(
  engine: GameEngine,
  broadcast: (event: ServerEvent) => void,
): CommandResult {
  const current = engine.getModeSession();
  if (!current) {
    return { message: "Not in a mode session." };
  }

  const label = current.label;

  // Clear the mode session
  engine.setModeSession(null);

  // Restore previous variant
  const previousVariant = engine.getPreviousVariant() ?? "exploration";
  broadcast({
    type: "session:mode",
    data: { mode: "play", variant: previousVariant },
  });

  return { message: `Exiting ${label} Mode` };
}

async function handleSnapshot(): Promise<CommandResult> {
  try {
    const v8 = await import("node:v8");
    const { writeFileSync } = await import("node:fs");
    const file = `heap-${Date.now()}.heapsnapshot`;
    writeFileSync(file, v8.writeHeapSnapshot());
    return { message: `Heap snapshot written: ${file}` };
  } catch (err) {
    return { message: `Snapshot failed: ${err instanceof Error ? err.message : err}`, error: true };
  }
}
