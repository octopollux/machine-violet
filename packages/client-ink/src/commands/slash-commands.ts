import v8 from "node:v8";
import { writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { ActiveModal, NarrativeLine, StyleVariant } from "@machine-violet/shared/types/tui.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "@machine-violet/shared/types/engine.js";
import type { ModeSession } from "../tui/game-context.js";
import { queryCommitLog, performRollback } from "../tools/git/index.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";

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
  dispatchTuiCommand?: (cmd: import("../agents/agent-loop.js").TuiCommand) => void;
  setActiveModal?: (modal: ActiveModal) => void;
  onReturnToMenu?: () => void;
  onRollbackComplete?: (summary: string) => void;
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
    const aliasLines = [...aliasMap.entries()].map(
      ([alias, target]) => `  ${("/" + alias).padEnd(20)}→ /${target}`,
    );
    const all = [...lines, "", ...aliasLines];
    ctx.appendLine({ kind: "system", text: `[Commands]\n${all.join("\n")}` });
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
    const result = await performRollback(repo, `exchanges_ago:${n}`, gs.campaignRoot, fileIO);
    if (ctx.onRollbackComplete) {
      ctx.onRollbackComplete(result.summary);
    } else if (ctx.onReturnToMenu) {
      ctx.onReturnToMenu();
    } else {
      process.exit(0);
    }
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
    onTuiCommand: ctx.dispatchTuiCommand,
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

const snapshotCommand: SlashCommand = {
  name: "snapshot",
  usage: "/snapshot",
  description: "Write a V8 heap snapshot for memory debugging",
  execute(_args, ctx) {
    ctx.appendLine({ kind: "system", text: "[Writing heap snapshot — this may pause for a few seconds...]" });
    const file = `heap-${Date.now()}.heapsnapshot`;
    try {
      writeFileSync(file, v8.writeHeapSnapshot());
      ctx.appendLine({ kind: "system", text: `[Heap snapshot written: ${file}]` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendLine({ kind: "system", text: `[Snapshot failed: ${msg}]` });
    }
  },
};

const retryCommand: SlashCommand = {
  name: "retry",
  usage: "/retry",
  description: "Retry the last DM turn (discards current response)",
  execute(_args, ctx) {
    if (!ctx.engine) {
      ctx.appendLine({ kind: "system", text: "[Retry unavailable — no active engine]" });
      return;
    }
    // If there's a pending error retry, just replay that
    if (ctx.engine.hasPendingRetry()) {
      ctx.appendLine({ kind: "dev", text: "[dev] retrying last failed turn" });
      ctx.engine.retryLastTurn();
      return;
    }
    // Otherwise pop the last exchange and replay
    const ok = ctx.engine.retryLastExchange();
    if (!ok) {
      ctx.appendLine({ kind: "system", text: "[Nothing to retry — no conversation history]" });
      return;
    }
    ctx.appendLine({ kind: "system", text: "[Retrying last turn...]" });
  },
};

const notesCommand: SlashCommand = {
  name: "notes",
  usage: "/notes",
  description: "Open the player notes editor",
  execute(_args, ctx) {
    if (!ctx.setActiveModal) {
      ctx.appendLine({ kind: "system", text: "[Notes unavailable]" });
      return;
    }
    const setModal = ctx.setActiveModal;
    const gs = ctx.gameState;
    const io = ctx.engine?.getSceneManager().getFileIO();
    if (gs && io) {
      const path = campaignPaths(gs.campaignRoot).playerNotes;
      io.readFile(path).then((raw: string) => {
        setModal({ kind: "notes", content: raw });
      }).catch(() => {
        setModal({ kind: "notes", content: "" });
      });
    } else {
      setModal({ kind: "notes", content: "" });
    }
  },
};

const swatchCommand: SlashCommand = {
  name: "swatch",
  usage: "/swatch",
  description: "Show the active theme's color swatch grid",
  execute(_args, ctx) {
    if (!ctx.setActiveModal) {
      ctx.appendLine({ kind: "system", text: "[Swatch modal unavailable]" });
      return;
    }
    ctx.setActiveModal({ kind: "swatch" });
  },
};

// --- Registry ---

const commands: SlashCommand[] = [
  helpCommand,
  saveCommand,
  logCommand,
  rollbackCommand,
  retryCommand,
  sceneCommand,
  oocCommand,
  devCommand,
  snapshotCommand,
  swatchCommand,
  notesCommand,
];

const commandMap = new Map<string, SlashCommand>(
  commands.map((c) => [c.name, c]),
);

/** Aliases map alternate names → canonical command names. */
const aliasMap = new Map<string, string>([
  ["dm", "ooc"],
]);

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

  // Resolve aliases (e.g. /dm → /ooc) so the canonical name is used everywhere
  const resolvedName = aliasMap.get(name) ?? name;

  const cmd = commandMap.get(resolvedName);
  if (!cmd) {
    ctx.appendLine({ kind: "system", text: `[Unknown command: /${name} — type /help for available commands]` });
    return true;
  }

  // Echo the command into the narrative pane so players see what was typed
  const echoText = args ? `/${resolvedName} ${args}` : `/${resolvedName}`;
  ctx.appendLine({ kind: "player", text: `> ${echoText}` });

  const result = cmd.execute(args, ctx);
  if (result instanceof Promise) {
    result.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.appendLine({ kind: "system", text: `[/${resolvedName} error: ${msg}]` });
    });
  }

  return true;
}
