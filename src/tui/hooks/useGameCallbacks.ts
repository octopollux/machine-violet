import { useCallback } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import type { FrameStyle, StyleVariant, NarrativeLine, ActiveModal } from "../../types/tui.js";
import type { EngineState, EngineCallbacks } from "../../agents/game-engine.js";
import type { TuiCommand, UsageStats } from "../../agents/agent-loop.js";
import type { GameState } from "../../agents/game-state.js";
import type { FileIO } from "../../agents/scene-manager.js";
import { getStyle } from "../frames/index.js";
import { campaignPaths } from "../../tools/filesystem/index.js";
import { getActivePlayer } from "../../agents/player-manager.js";
import { shouldGenerateChoices, generateChoices } from "../../agents/subagents/choice-generator.js";
import { getModel } from "../../config/models.js";
import { CostTracker } from "../../context/cost-tracker.js";
import { isDevMode } from "../../config/dev-mode.js";
import type { ToolResult } from "../../agents/tool-registry.js";
import { appendDelta } from "../narrative-helpers.js";

/** All external state/setters the hook needs, passed as a single deps object. */
export interface GameCallbackDeps {
  // Setters
  setNarrativeLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>>;
  setEngineState: (s: string | null) => void;
  setErrorMsg: (s: string | null) => void;
  setModelines: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setResources: (r: string[]) => void;
  setStyle: (s: FrameStyle) => void;
  setVariant: (v: StyleVariant) => void;
  setActiveModal: (m: ActiveModal) => void;
  setChoiceIndex: React.Dispatch<React.SetStateAction<number>>;
  setOocActive: (v: boolean) => void;
  // Refs
  gameStateRef: React.RefObject<GameState | null>;
  clientRef: React.RefObject<Anthropic | null>;
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

export function useGameCallbacks(deps: GameCallbackDeps): GameCallbackResult {
  const {
    setNarrativeLines, setEngineState, setErrorMsg, setModelines,
    setResources, setStyle, setVariant, setActiveModal, setChoiceIndex,
    setOocActive,
    gameStateRef, clientRef, activeModalRef, variantRef, previousVariantRef,
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
      case "set_ui_style": {
        setVariant(cmd.variant as StyleVariant);
        const found = getStyle(cmd.style as string);
        if (found) setStyle(found);
        break;
      }
      case "set_display_resources":
        setResources(cmd.resources as string[]);
        break;
      case "present_choices": {
        const raw = cmd.choices;
        const choices = Array.isArray(raw)
          ? raw.map((c: unknown) => typeof c === "string" ? c : String(c))
          : [];
        if (choices.length > 0) {
          setChoiceIndex(0);
          setActiveModal({ kind: "choice", prompt: (cmd.prompt as string) || "What do you do?", choices });
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
          fileIO.current.readFile(path).then((content) => {
            setActiveModal({ kind: "character_sheet", content });
          }).catch(() => {
            setActiveModal({ kind: "character_sheet", content: `[Could not load character sheet for ${charName}]` });
          });
        }
        break;
      }
      case "enter_ooc":
        previousVariantRef.current = variantRef.current;
        setOocActive(true);
        setVariant("ooc");
        setNarrativeLines((prev) => [...prev, { kind: "system", text: "[OOC Mode \u2014 type to chat, ESC to exit]" }, { kind: "dm", text: "" }]);
        break;
    }
  }, [setModelines, setVariant, setStyle, setResources, setChoiceIndex,
      setActiveModal, setOocActive, setNarrativeLines, gameStateRef, fileIO,
      previousVariantRef, variantRef]);

  const buildCallbacks = useCallback((): EngineCallbacks => ({
    onNarrativeDelta(delta: string) {
      setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
    },
    onNarrativeComplete(text: string) {
      setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);

      const gs = gameStateRef.current;
      if (gs && clientRef.current) {
        const dmProvided = activeModalRef.current?.kind === "choice";
        if (shouldGenerateChoices(gs.config.choices.campaign_default, dmProvided)) {
          const activePlayer = getActivePlayer(gs);
          if (isDevMode()) {
            setNarrativeLines((prev) => [...prev, { kind: "dev", text: "[dev] subagent:choices starting" }]);
          }
          generateChoices(clientRef.current, text, activePlayer.characterName).then((result) => {
            if (isDevMode()) {
              setNarrativeLines((prev) => [...prev, { kind: "dev", text: `[dev] subagent:choices \u2192 ${result.choices.length} options generated` }]);
            }
            if (!activeModalRef.current && result.choices.length > 0) {
              setChoiceIndex(0);
              setActiveModal({ kind: "choice", prompt: "What do you do?", choices: result.choices });
            }
            costTracker.current.record(result.usage, getModel("small"));
          }).catch(() => { /* best-effort */ });
        }
      }
    },
    onStateChange(state: EngineState) {
      setEngineState(state);
    },
    onTuiCommand(cmd: TuiCommand) {
      dispatchTuiCommand(cmd);
    },
    onToolStart(name: string) {
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
      costTracker.current.record(usage, getModel("large"));
    },
    onError(error: Error) {
      setErrorMsg(error.message);
      setNarrativeLines((prev) => [
        ...prev,
        { kind: "system", text: `[Error: ${error.message}]` },
        { kind: "system", text: "[Debug info saved to .debug/ folder]" },
      ]);
    },
    onRetry(status: number, delayMs: number) {
      setEngineState(`retry:${status}:${Math.ceil(delayMs / 1000)}`);
    },
  }), [dispatchTuiCommand, setNarrativeLines, setEngineState,
       setErrorMsg, setActiveModal, setChoiceIndex,
       gameStateRef, clientRef, activeModalRef, costTracker]);

  return { buildCallbacks, dispatchTuiCommand };
}
