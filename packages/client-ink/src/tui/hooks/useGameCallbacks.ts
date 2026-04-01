import { useCallback } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import type { NarrativeLine, ActiveModal, RetryOverlay } from "@machine-violet/shared/types/tui.js";
import type { StyleVariant } from "../themes/types.js";
import type { EngineState, EngineCallbacks, TurnInfo } from "../../agents/game-engine.js";
import type { TuiCommand } from "../../agents/agent-loop.js";
import type { GameState } from "../../agents/game-state.js";
import type { GameEngine } from "../../agents/game-engine.js";
import type { FileIO } from "../../agents/scene-manager.js";
import type { ModeSession } from "../game-context.js";
import type { ToolGlyph } from "../activity.js";

import { campaignPaths } from "../../tools/filesystem/index.js";
import { getActivePlayer } from "../../agents/player-manager.js";
import { shouldGenerateChoices, generateChoices } from "../../agents/subagents/choice-generator.js";
import { createOOCSession } from "../../agents/subagents/ooc-mode.js";
import { CostTracker } from "../../context/cost-tracker.js";

import type { ToolResult } from "../../agents/tool-registry.js";
import { appendDelta } from "../narrative-helpers.js";
import { getToolGlyph } from "../activity.js";
import { RollbackCompleteError } from "../../teardown.js";

/** All external state/setters the hook needs, passed as a single deps object. */
export interface GameCallbackDeps {
  // Return-to-menu callback (triggered by rollback TUI command)
  onReturnToMenu: () => void;
  // Setters
  setNarrativeLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>>;
  setEngineState: (s: string | null) => void;
  setErrorMsg: (s: string | null) => void;
  setModelines: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setResources: (r: string[]) => void;
  setVariant: (v: StyleVariant) => void;
  setThemeName: (name: string) => void;
  setKeyColor: (color: string) => void;
  setActiveModal: (m: ActiveModal) => void;
  setActiveSession: (s: ModeSession | null) => void;
  setRetryOverlay: (o: RetryOverlay | null) => void;
  setToolGlyphs: React.Dispatch<React.SetStateAction<ToolGlyph[]>>;
  // Refs
  gameStateRef: React.RefObject<GameState | null>;
  clientRef: React.RefObject<Anthropic | null>;
  engineRef: React.RefObject<GameEngine | null>;
  activeModalRef: React.RefObject<ActiveModal>;
  variantRef: React.RefObject<StyleVariant>;
  previousVariantRef: React.MutableRefObject<StyleVariant>;
  costTracker: React.RefObject<CostTracker>;
  fileIO: React.RefObject<FileIO>;
  /** Optional hook called after each turn ends (used by Discord presence). */
  onTurnEndExtra?: (turn: TurnInfo) => void;
}

export interface GameCallbackResult {
  buildCallbacks: () => EngineCallbacks;
  dispatchTuiCommand: (cmd: TuiCommand) => void;
}

/** Combine display keys + values into formatted strings for the top frame. */
export function formatResources(gs: GameState): string[] {
  const result: string[] = [];
  for (const [char, keys] of Object.entries(gs.displayResources)) {
    const vals = gs.resourceValues[char] ?? {};
    for (const key of keys) {
      const val = vals[key];
      result.push(val ? `${key} ${val}` : key);
    }
  }
  return result;
}

export function useGameCallbacks(deps: GameCallbackDeps): GameCallbackResult {
  const {
    onReturnToMenu,
    setNarrativeLines, setEngineState, setErrorMsg, setModelines,
    setResources, setVariant, setThemeName, setKeyColor,
    setActiveModal,
    setActiveSession, setRetryOverlay, setToolGlyphs,
    gameStateRef, clientRef, engineRef, activeModalRef, variantRef, previousVariantRef,
    costTracker, fileIO,
  } = deps;

  const dispatchTuiCommand = useCallback((cmd: TuiCommand) => {
    switch (cmd.type) {
      case "update_modeline": {
        const char = cmd.character as string;
        const text = cmd.text as string;
        setModelines((prev) => ({ ...prev, [char]: text }));
        break;
      }
      case "set_theme":
      case "style_scene": {
        if (cmd.theme) setThemeName(cmd.theme as string);
        if (cmd.key_color) setKeyColor(cmd.key_color as string);
        if (cmd.variant) setVariant(cmd.variant as StyleVariant);
        break;
      }
      case "set_display_resources":
      case "set_resource_values":
      case "resource_refresh": {
        // GameState is already mutated by the tool handler in dispatch().
        // Just sync React state so the TUI updates and the persist effect fires.
        const gs1 = gameStateRef.current;
        if (gs1) setResources(formatResources(gs1));
        break;
      }
      case "present_choices": {
        const raw = cmd.choices;
        const choices = Array.isArray(raw)
          ? raw.map((c: unknown) => typeof c === "string" ? c : String(c))
          : [];
        if (choices.length > 0) {
          const rawDescs = cmd.descriptions;
          const descriptions = Array.isArray(rawDescs) && rawDescs.length > 0
            ? rawDescs.map((d: unknown) => typeof d === "string" ? d : String(d))
            : undefined;
          setActiveModal({ kind: "choice", prompt: (cmd.prompt as string) || "What do you do?", choices, descriptions });
        }
        break;
      }
      case "show_character_sheet": {
        const charName = cmd.character as string;
        const gs = gameStateRef.current;
        if (gs) {
          const path = campaignPaths(gs.campaignRoot).character(charName);
          fileIO.current?.readFile(path).then((content) => {
            setActiveModal({ kind: "character_sheet", content });
          }).catch(() => {
            setActiveModal({ kind: "character_sheet", content: `[Could not load character sheet for ${charName}]` });
          });
        }
        break;
      }
      case "return_to_menu": {
        onReturnToMenu();
        break;
      }
      case "show_rollback_summary": {
        setActiveModal({ kind: "rollback", summary: cmd.summary as string });
        break;
      }
      case "enter_ooc": {
        previousVariantRef.current = variantRef.current ?? "exploration";
        const gs = gameStateRef.current;
        const client = clientRef.current;
        if (gs && client) {
          const engine = engineRef.current;
          const sm = engine?.getSceneManager();
          setActiveSession(createOOCSession(client, {
            campaignName: gs.config.name,
            previousVariant: variantRef.current ?? "exploration",
            config: gs.config,
            sessionState: sm?.getSessionState(),
            repo: engine?.getRepo() ?? undefined,
            fileIO: sm?.getFileIO(),
            campaignRoot: gs.campaignRoot,
            gameState: gs,
            onTuiCommand: (cmd) => dispatchTuiCommand(cmd),
          }));
        }
        setVariant("ooc");
        setNarrativeLines((prev) => [...prev, { kind: "system", text: "[OOC Mode \u2014 type to chat, ESC to exit]" }, { kind: "dm", text: "" }]);
        break;
      }
    }
  }, [onReturnToMenu, setModelines, setVariant, setThemeName, setKeyColor, setResources,
      setActiveModal, setActiveSession, setNarrativeLines, gameStateRef, clientRef, engineRef, fileIO,
      previousVariantRef, variantRef]);

  const buildCallbacks = useCallback((): EngineCallbacks => ({
    onNarrativeDelta(delta: string) {
      setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
    },
    onNarrativeComplete(text: string, playerAction?: string) {
      setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);

      const gs = gameStateRef.current;
      if (gs && clientRef.current) {
        const dmProvided = activeModalRef.current?.kind === "choice";
        if (text && shouldGenerateChoices(gs.config.choices.campaign_default, dmProvided)) {
          const activePlayer = getActivePlayer(gs);
          setNarrativeLines((prev) => [...prev, { kind: "dev", text: "[dev] subagent:choices starting" }]);
          generateChoices(clientRef.current, text, activePlayer.characterName, playerAction).then((result) => {
            setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] subagent:choices \u2192 ${result.choices.length} options generated` }]);
            if (!activeModalRef.current && result.choices.length > 0) {
              setActiveModal({ kind: "choice", prompt: "What do you do?", choices: result.choices });
            }
            const ct = costTracker.current;
            if (ct) {
              ct.record(result.usage, "small");
              engineRef.current?.getPersister()?.persistUsage(ct.getBreakdown());
            }
          }).catch(() => { /* best-effort */ });
        }
      }
    },
    onStateChange(state: EngineState) {
      setEngineState(state);
      setRetryOverlay(null);
      // Clear accumulated tool glyphs when the DM turn ends
      if (state === "waiting_input" || state === "idle") {
        setToolGlyphs([]);
      }
    },
    onTuiCommand(cmd: TuiCommand) {
      dispatchTuiCommand(cmd);
    },
    onToolStart(name: string) {
      // Accumulate a glyph on the activity line for each tool call
      const tg = getToolGlyph(name);
      if (tg) {
        setToolGlyphs((prev) => [...prev, tg]);
      }
      setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] tool:${name} ...` }]);
    },
    onToolEnd(name: string, result?: ToolResult) {
      if (result) {
        const preview = result.content.length > 80
          ? result.content.slice(0, 77) + "..."
          : result.content;
        const status = result.is_error ? " ERROR" : "";
        setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] tool:${name}${status} \u2192 ${preview}` }]);
      }
    },
    onDevLog(msg: string) {
      setNarrativeLines((prev) => [...prev, { kind: "dev", text: msg }]);
    },
    onExchangeDropped() { /* precis update handled internally */ },
    onUsageUpdate(delta, tier) {
      const ct = costTracker.current;
      if (ct) {
        ct.record(delta, tier);
        engineRef.current?.getPersister()?.persistUsage(ct.getBreakdown());
      }
    },
    onRefusal() {
      setNarrativeLines((prev) => {
        // Remove trailing "dm" lines (partial streamed text from refused response)
        let cutIdx = prev.length;
        while (cutIdx > 0 && prev[cutIdx - 1].kind === "dm") {
          cutIdx--;
        }
        return [
          ...prev.slice(0, cutIdx),
          { kind: "system" as const, text: "[The story went somewhere I can't follow. Try a different direction!]" },
        ];
      });
    },
    onError(error: Error) {
      // Rollback-complete errors are handled via TUI command — not a real error
      if (error instanceof RollbackCompleteError) return;
      setErrorMsg(error.message);
      const lines: NarrativeLine[] = [
        { kind: "system", text: `[Error: ${error.message}]` },
        { kind: "system", text: "[Debug info saved to .debug/ folder]" },
      ];
      // If the engine stored the failed input, prompt the player to retry
      if (engineRef.current?.hasPendingRetry()) {
        lines.push({ kind: "system", text: "[Press Enter to retry]" });
      }
      setNarrativeLines((prev) => [...prev, ...lines]);
    },
    onRetry(status: number, delayMs: number) {
      const delaySec = Math.ceil(delayMs / 1000);
      setEngineState(`retry:${status}:${delaySec}`);
      setRetryOverlay({ status, delaySec });
    },
    onTurnStart(turn: TurnInfo) {
      if (turn.role === "player") {
        setNarrativeLines((prev) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant}: ${turn.text}` },
        ]);
      } else if (turn.role === "ai") {
        setNarrativeLines((prev) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant} (AI): ${turn.text}` },
        ]);
      }
      // role === "dm" → no-op (onNarrativeDelta handles DM text rendering)
    },
    onTurnEnd(turn: TurnInfo) {
      setNarrativeLines((prev) => [...prev, { kind: "separator", text: "" }]);
      deps.onTurnEndExtra?.(turn);
    },
  }), [dispatchTuiCommand, setNarrativeLines, setEngineState,
       setErrorMsg, setActiveModal, setRetryOverlay, setToolGlyphs,
       gameStateRef, clientRef, activeModalRef, costTracker]);

  return { buildCallbacks, dispatchTuiCommand };
}
