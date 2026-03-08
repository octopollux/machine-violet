import type Anthropic from "@anthropic-ai/sdk";
import type { NarrativeLine, StyleVariant } from "../types/tui.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "../agents/game-state.js";
import type { ModeSession } from "../tui/game-context.js";
import { queryCommitLog, performRollback } from "../tools/git/index.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";

export interface SlashCommandContext {
  engine: GameEngine | null;
  gameState: GameState | null;
  client: Anthropic | null;
  appendLine: (line: NarrativeLine) => void;
  activeSession: ModeSession | null;
  setActiveSession: (s: ModeSession | null) => void;
  variant: StyleVariant;
  setVariant: (v: StyleVariant) => void;
  previousVariant: StyleVariant;
  setPreviousVariant: (v: StyleVariant) => void;
}

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  execute(args: string, ctx: SlashCommandContext): void | Promise<void>;
}

// --- Command implementations ---

const helpCommand: SlashCommand = {
  name: "help",
  usage: "/help",
  description: "List all slash commands",
  execute(_args, ctx) {
    const lines = commands.map((c) => `  ${c.usage.padEnd(20)} ${c.description}`);
    ctx.appendLine({ kind: "system", text: `[Commands]\n${lines.join("\n")}` });
  },
};

const saveCommand: SlashCommand = {
  name: "save",
  usage: "/save [label]",
  description: "Create a manual save checkpoint",
  async execute(args, ctx) {
    const repo = ctx.engine?.getRepo();
    if (!repo || !repo.isEnabled()) {
      ctx.appendLine({ kind: "system", text: "[Save unavailable — git is disabled]" });
      return;
    }
    const label = args.trim() || "manual save";
    const oid = await repo.checkpoint(label);
    if (oid) {
      ctx.appendLine({ kind: "system", text: `[Saved: ${oid.slice(0, 7)} — ${label}]` });
    } else {
      ctx.appendLine({ kind: "system", text: "[No changes to save]" });
    }
  },
};

const logCommand: SlashCommand = {
  name: "log",
  usage: "/log [depth]",
  description: "Show recent commit history",
  async execute(args, ctx) {
    const repo = ctx.engine?.getRepo();
    if (!repo || !repo.isEnabled()) {
      ctx.appendLine({ kind: "system", text: "[Log unavailable — git is disabled]" });
      return;
    }
    const depth = args.trim() ? parseInt(args.trim(), 10) : undefined;
    if (depth !== undefined && (isNaN(depth) || depth < 1)) {
      ctx.appendLine({ kind: "system", text: "[Usage: /log [depth] — depth must be a positive number]" });
      return;
    }
    const result = await queryCommitLog(repo, { depth });
    ctx.appendLine({ kind: "system", text: `[${result}]` });
  },
};

const rollbackCommand: SlashCommand = {
  name: "rollback",
  usage: "/rollback <N>",
  description: "Roll back N exchanges and restart",
  async execute(args, ctx) {
    const n = parseInt(args.trim(), 10);
    if (!args.trim() || isNaN(n) || n < 1) {
      ctx.appendLine({ kind: "system", text: "[Usage: /rollback <N> — N = number of exchanges to undo]" });
      return;
    }
    const repo = ctx.engine?.getRepo();
    if (!repo || !repo.isEnabled()) {
      ctx.appendLine({ kind: "system", text: "[Rollback unavailable — git is disabled]" });
      return;
    }
    const gs = ctx.gameState;
    if (!gs) {
      ctx.appendLine({ kind: "system", text: "[Rollback unavailable — no active game]" });
      return;
    }
    const fileIO = ctx.engine?.getSceneManager().getFileIO();
    if (!fileIO) {
      ctx.appendLine({ kind: "system", text: "[Rollback unavailable — no file IO]" });
      return;
    }
    ctx.appendLine({ kind: "system", text: `[Rolling back ${n} exchange(s)...]` });
    await performRollback(repo, `exchanges_ago:${n}`, gs.campaignRoot, fileIO);
    process.exit(0);
  },
};

const sceneCommand: SlashCommand = {
  name: "scene",
  usage: "/scene <title>",
  description: "Transition to a new scene",
  async execute(args, ctx) {
    const title = args.trim();
    if (!title) {
      ctx.appendLine({ kind: "system", text: "[Usage: /scene <title>]" });
      return;
    }
    if (!ctx.engine) {
      ctx.appendLine({ kind: "system", text: "[Scene transition unavailable — no active engine]" });
      return;
    }
    ctx.appendLine({ kind: "system", text: `[Transitioning: ${title}]` });
    await ctx.engine.transitionScene(title);
  },
};

function enterOOCMode(ctx: SlashCommandContext): void {
  if (!ctx.client || !ctx.gameState || !ctx.engine) {
    ctx.appendLine({ kind: "system", text: "[OOC Mode unavailable — missing client or game state]" });
    return;
  }
  const gs = ctx.gameState;
  const sm = ctx.engine.getSceneManager();
  ctx.setPreviousVariant(ctx.variant);
  ctx.setActiveSession(createOOCSession(ctx.client, {
    campaignName: gs.config.name,
    previousVariant: ctx.variant,
    config: gs.config,
    sessionState: sm.getSessionState(),
    repo: ctx.engine.getRepo() ?? undefined,
    fileIO: sm.getFileIO(),
    campaignRoot: gs.campaignRoot,
  }));
  ctx.setVariant("ooc");
  ctx.appendLine({ kind: "system", text: "[OOC Mode — type to chat, ESC to exit]" });
}

function enterDevMode(ctx: SlashCommandContext): void {
  if (!ctx.client || !ctx.gameState || !ctx.engine) {
    ctx.appendLine({ kind: "system", text: "[Dev Mode unavailable — missing client or game state]" });
    return;
  }
  const gs = ctx.gameState;
  ctx.setPreviousVariant(ctx.variant);
  ctx.setActiveSession(createDevSession(ctx.client, {
    campaignName: gs.config.name,
    gameStateSummary: summarizeGameState(gs),
    gameState: gs,
    fileIO: ctx.engine.getSceneManager().getFileIO(),
    sceneManager: ctx.engine.getSceneManager(),
    repo: ctx.engine.getRepo() ?? undefined,
  }));
  ctx.setVariant("dev");
  ctx.appendLine({ kind: "system", text: "[Dev Mode — type to inspect, ESC to exit]" });
}

function exitSession(ctx: SlashCommandContext): void {
  if (!ctx.activeSession) return;
  const label = ctx.activeSession.label;
  ctx.setActiveSession(null);
  ctx.setVariant(ctx.previousVariant);
  ctx.appendLine({ kind: "system", text: `[Exiting ${label} Mode]` });
}

const oocCommand: SlashCommand = {
  name: "ooc",
  usage: "/ooc",
  description: "Toggle OOC (Out-of-Character) mode",
  execute(_args, ctx) {
    if ((ctx.activeSession as null | { label: string })?.label === "OOC") {
      exitSession(ctx);
    } else {
      if (ctx.activeSession) exitSession(ctx);
      enterOOCMode(ctx);
    }
  },
};

const devCommand: SlashCommand = {
  name: "dev",
  usage: "/dev",
  description: "Toggle Dev mode",
  execute(_args, ctx) {
    if ((ctx.activeSession as null | { label: string })?.label === "Dev") {
      exitSession(ctx);
    } else {
      if (ctx.activeSession) exitSession(ctx);
      enterDevMode(ctx);
    }
  },
};

// --- Registry ---

const commands: SlashCommand[] = [
  helpCommand,
  saveCommand,
  logCommand,
  rollbackCommand,
  sceneCommand,
  oocCommand,
  devCommand,
];

const commandMap = new Map<string, SlashCommand>(
  commands.map((c) => [c.name, c]),
);

/**
 * Try to parse and dispatch a slash command.
 * Returns true if the input was a slash command (handled or errored),
 * false if it should pass through to normal input handling.
 */
export function trySlashCommand(input: string, ctx: SlashCommandContext): boolean {
  if (!input.startsWith("/")) return false;

  const spaceIndex = input.indexOf(" ");
  const name = (spaceIndex === -1 ? input.slice(1) : input.slice(1, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1);

  if (!name) return false;

  const cmd = commandMap.get(name);
  if (!cmd) {
    ctx.appendLine({ kind: "system", text: `[Unknown command: /${name} — type /help for available commands]` });
    return true;
  }

  const result = cmd.execute(args, ctx);
  if (result instanceof Promise) {
    result.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendLine({ kind: "system", text: `[/${name} error: ${msg}]` });
    });
  }

  return true;
}
