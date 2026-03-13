import { useCallback } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import type { NarrativeLine, ActiveModal, RetryOverlay } from "../../types/tui.js";
import type { StyleVariant } from "../themes/types.js";
import type { EngineState, EngineCallbacks, TurnInfo } from "../../agents/game-engine.js";
import type { TuiCommand, UsageStats } from "../../agents/agent-loop.js";
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
import { isDevMode } from "../../config/dev-mode.js";
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
  setChoiceIndex: React.Dispatch<React.SetStateAction<number>>;
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
    setActiveModal, setChoiceIndex,
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
      case "set_display_resources": {
        const gs1 = gameStateRef.current;
        if (gs1) {
          const char = cmd.character as string;
          gs1.displayResources[char] = cmd.resources as string[];
          setResources(formatResources(gs1));
        }
        break;
      }
      case "set_resource_values": {
        const gs2 = gameStateRef.current;
        if (gs2) {
          const char = cmd.character as string;
          const vals = cmd.values as Record<string, string>;
          if (!gs2.resourceValues[char]) gs2.resourceValues[char] = {};
          Object.assign(gs2.resourceValues[char], vals);
          setResources(formatResources(gs2));
        }
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
          // When fewer than 5 options, default focus to "Enter your own" so the user can freely type
          setChoiceIndex(choices.length < 5 ? choices.length : 0);
          setActiveModal({ kind: "choice", prompt: (cmd.prompt as string) || "What do you do?", choices, descriptions });
        }
        break;
      }
      case "present_roll":
        setActiveModal({
          kind: "dice",
          expression: cmd.expression as string,
          rolls: cmd.rolls as number[],
          kept: cmd.kept as number[] | undefined,
          total: cmd.total as number,
          reason: cmd.reason as string | undefined,
        });
        break;
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
  }, [onReturnToMenu, setModelines, setVariant, setThemeName, setKeyColor, setResources, setChoiceIndex,
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
          if (isDevMode()) {
            setNarrativeLines((prev) => [...prev, { kind: "dev", text: "[dev] subagent:choices starting" }]);
          }
          generateChoices(clientRef.current, text, activePlayer.characterName, playerAction).then((result) => {
            if (isDevMode()) {
              setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] subagent:choices \u2192 ${result.choices.length} options generated` }]);
            }
            if (!activeModalRef.current && result.choices.length > 0) {
              // When fewer than 5 options, default focus to "Enter your own"
              setChoiceIndex(result.choices.length < 5 ? result.choices.length : 0);
              setActiveModal({ kind: "choice", prompt: "What do you do?", choices: result.choices });
            }
            costTracker.current?.record(result.usage, "small");
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
      if (isDevMode()) {
        setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] tool:${name} ...` }]);
      }
    },
    onToolEnd(name: string, result?: ToolResult) {
      if (isDevMode() && result) {
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
    onUsageUpdate(usage: UsageStats) {
      costTracker.current?.record(usage, "large");
    },
    onError(error: Error) {
      // Rollback-complete errors are handled via TUI command — not a real error
      if (error instanceof RollbackCompleteError) return;
      setErrorMsg(error.message);
      setNarrativeLines((prev) => [
        ...prev,
        { kind: "system", text: `[Error: ${error.message}]` },
        { kind: "system", text: "[Debug info saved to .debug/ folder]" },
      ]);
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
    onTurnEnd(_turn: TurnInfo) {
      setNarrativeLines((prev) => [...prev, { kind: "separator", text: "" }]);
    },
  }), [dispatchTuiCommand, setNarrativeLines, setEngineState,
       setErrorMsg, setActiveModal, setChoiceIndex, setRetryOverlay, setToolGlyphs,
       gameStateRef, clientRef, activeModalRef, costTracker]);

  return { buildCallbacks, dispatchTuiCommand };
}
