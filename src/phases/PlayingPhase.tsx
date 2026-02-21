import React, { useState, useRef, useMemo } from "react";
import { useInput, useStdout, Box } from "ink";
import type Anthropic from "@anthropic-ai/sdk";
import type { FrameStyle, StyleVariant } from "../types/tui.js";
import type { ActiveModal } from "../app.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount } from "../tui/components/index.js";
import { Layout } from "../tui/layout.js";
import { ChoiceModal, DiceRollModal, SessionRecapModal, GameMenu, CharacterSheetModal, getMenuItems } from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "../agents/game-state.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "../agents/player-manager.js";
import { CostTracker } from "../context/cost-tracker.js";
import { enterOOC } from "../agents/subagents/ooc-mode.js";
import { enterDevMode, summarizeGameState } from "../agents/subagents/dev-mode.js";
import { getModel } from "../config/models.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";

export interface PlayingPhaseProps {
  // Refs
  engineRef: React.RefObject<GameEngine | null>;
  gameStateRef: React.RefObject<GameState | null>;
  clientRef: React.RefObject<Anthropic | null>;
  costTracker: React.RefObject<CostTracker>;
  // Narrative
  narrativeLines: string[];
  setNarrativeLines: React.Dispatch<React.SetStateAction<string[]>>;
  // Style
  style: FrameStyle;
  variant: StyleVariant;
  setVariant: (v: StyleVariant) => void;
  // Display
  campaignName: string;
  activePlayerIndex: number;
  setActivePlayerIndex: (i: number) => void;
  engineState: string | null;
  resources: string[];
  modelineOverride: string | null;
  // Modal state (owned by App, since buildCallbacks/dispatchTuiCommand sets it)
  activeModal: ActiveModal;
  setActiveModal: (m: ActiveModal) => void;
  choiceIndex: number;
  setChoiceIndex: React.Dispatch<React.SetStateAction<number>>;
  // OOC state (owned by App, since dispatchTuiCommand sets it)
  oocActive: boolean;
  setOocActive: (v: boolean) => void;
  previousVariantRef: React.MutableRefObject<StyleVariant>;
  // Dev mode state (owned by App)
  devModeEnabled?: boolean;
  devActive: boolean;
  setDevActive: (v: boolean) => void;
  // Actions
  dispatchTuiCommand: (cmd: import("../agents/agent-loop.js").TuiCommand) => void;
  onShutdown: () => void;
}

export function PlayingPhase({
  engineRef,
  gameStateRef,
  clientRef,
  costTracker,
  narrativeLines,
  setNarrativeLines,
  style,
  variant,
  setVariant,
  campaignName,
  activePlayerIndex,
  setActivePlayerIndex,
  engineState,
  resources,
  modelineOverride,
  activeModal,
  setActiveModal,
  choiceIndex,
  setChoiceIndex,
  oocActive,
  setOocActive,
  previousVariantRef,
  devModeEnabled,
  devActive,
  setDevActive,
  dispatchTuiCommand,
  onShutdown,
}: PlayingPhaseProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  // Local state — only used within playing phase input/render
  const [inputValue, setInputValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [oocBusy, setOocBusy] = useState(false);
  const [devBusy, setDevBusy] = useState(false);
  const { handleKey: handleTextKey } = useTextInput({ value: inputValue, onChange: setInputValue });

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);

  const menuItems = useMemo(() => getMenuItems(devModeEnabled), [devModeEnabled]);

  // --- Input handling ---
  useInput((input, key) => {
    // Triple-ESC reset: 3 ESC presses within 1.5s clears all overlay state
    if (key.escape) {
      const now = Date.now();
      escTimestamps.current.push(now);
      escTimestamps.current = escTimestamps.current.filter((t) => now - t <= 1500);
      if (escTimestamps.current.length >= 3) {
        escTimestamps.current = [];
        setActiveModal(null);
        setChoiceIndex(0);
        setMenuOpen(false);
        setMenuIndex(0);
        if (oocActive) {
          setOocActive(false);
          setVariant(previousVariantRef.current);
        }
        if (devActive) {
          setDevActive(false);
          setVariant(previousVariantRef.current);
        }
        return;
      }
    }

    // Dice modal: any key dismisses
    if (activeModal && activeModal.kind === "dice") {
      setActiveModal(null);
      return;
    }

    // Scrollable modals (character sheet, recap)
    if (activeModal && (activeModal.kind === "character_sheet" || activeModal.kind === "recap")) {
      if (key.escape || key.return) {
        setActiveModal(null);
        return;
      }
      if (key.pageUp || key.pageDown) {
        const step = scrollAmount(rows);
        modalScrollRef.current?.scrollBy(key.pageUp ? -step : step);
        return;
      }
      if (input === "+" || input === "-") {
        const step = scrollAmount(rows);
        modalScrollRef.current?.scrollBy(input === "-" ? -step : step);
        return;
      }
      if (key.upArrow) {
        modalScrollRef.current?.scrollBy(-1);
        return;
      }
      if (key.downArrow) {
        modalScrollRef.current?.scrollBy(1);
        return;
      }
      return;
    }

    // Choice modal
    if (activeModal && activeModal.kind === "choice") {
      if (key.escape) {
        setActiveModal(null);
        setChoiceIndex(0);
        return;
      }
      if (key.upArrow) {
        setChoiceIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setChoiceIndex((i) => Math.min(activeModal.choices.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const chosen = activeModal.choices[choiceIndex];
        setActiveModal(null);
        setChoiceIndex(0);
        if (engineRef.current && gameStateRef.current) {
          const active = getActivePlayer(gameStateRef.current);
          setNarrativeLines((prev) => [...prev, "", `> ${active.characterName}: ${chosen}`, ""]);
          engineRef.current.processInput(active.characterName, chosen);
        }
      }
      return;
    }

    // Dev mode input
    if (devActive) {
      if (key.escape) {
        setDevActive(false);
        setVariant(previousVariantRef.current);
        setNarrativeLines((prev) => [...prev, "[Exiting Dev Mode]", ""]);
        return;
      }
      if (devBusy) return;

      if (key.return && inputValue.trim()) {
        const text = inputValue.trim();
        setInputValue("");
        setNarrativeLines((prev) => [...prev, `> ${text}`, ""]);
        if (clientRef.current && gameStateRef.current) {
          const gs = gameStateRef.current;
          const fileIO = engineRef.current?.getSceneManager().getFileIO();
          setDevBusy(true);
          enterDevMode(clientRef.current, text, {
            campaignName: gs.config.name,
            gameStateSummary: summarizeGameState(gs),
            gameState: gs,
            fileIO,
          }, (delta) => {
            setNarrativeLines((prev) => {
              const lines = [...prev];
              if (lines.length === 0) lines.push(delta);
              else lines[lines.length - 1] += delta;
              return lines;
            });
          }).then((result) => {
            setDevBusy(false);
            setNarrativeLines((prev) => [...prev, ""]);
            costTracker.current.record(result.usage, getModel("medium"));
          }).catch(() => {
            setDevBusy(false);
            setNarrativeLines((prev) => [...prev, "[Dev mode error]", ""]);
          });
        }
        return;
      }
      handleTextKey(input, key);
      return;
    }

    // OOC mode
    if (oocActive) {
      if (key.escape) {
        setOocActive(false);
        setVariant(previousVariantRef.current);
        setNarrativeLines((prev) => [...prev, "[Exiting OOC Mode]", ""]);
        return;
      }
      if (oocBusy) return;

      if (key.return && inputValue.trim()) {
        const text = inputValue.trim();
        setInputValue("");
        setNarrativeLines((prev) => [...prev, `> ${text}`, ""]);
        if (clientRef.current && gameStateRef.current) {
          const gs = gameStateRef.current;
          setOocBusy(true);
          enterOOC(clientRef.current, text, {
            campaignName: gs.config.name,
            previousVariant: previousVariantRef.current,
          }, (delta) => {
            setNarrativeLines((prev) => {
              const lines = [...prev];
              if (lines.length === 0) lines.push(delta);
              else lines[lines.length - 1] += delta;
              return lines;
            });
          }).then((result) => {
            setOocBusy(false);
            setNarrativeLines((prev) => [...prev, ""]);
            costTracker.current.record(result.usage, getModel("medium"));
          }).catch(() => {
            setOocBusy(false);
            setNarrativeLines((prev) => [...prev, "[OOC error]", ""]);
          });
        }
        return;
      }
      handleTextKey(input, key);
      return;
    }

    // ESC toggles game menu
    if (key.escape) {
      setMenuOpen((v) => !v);
      setMenuIndex(0);
      return;
    }

    // Game menu navigation
    if (menuOpen) {
      if (key.upArrow) {
        setMenuIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setMenuIndex((i) => Math.min(menuItems.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const item = menuItems[menuIndex];
        if (item === "Resume") {
          setMenuOpen(false);
        } else if (item === "Save & Quit") {
          setMenuOpen(false);
          onShutdown();
        } else if (item === "Character Sheet") {
          setMenuOpen(false);
          const gs = gameStateRef.current;
          if (gs) {
            const active = getActivePlayer(gs);
            dispatchTuiCommand({ type: "show_character_sheet", character: active.characterName });
          }
        } else if (item === "OOC Mode") {
          setMenuOpen(false);
          if (oocActive) {
            setOocActive(false);
            setVariant(previousVariantRef.current);
            setNarrativeLines((prev) => [...prev, "[Exiting OOC Mode]", ""]);
          } else {
            previousVariantRef.current = variant;
            setOocActive(true);
            setVariant("ooc");
            setNarrativeLines((prev) => [...prev, "[OOC Mode \u2014 type to chat, ESC to exit]", ""]);
          }
        } else if (item === "Dev Mode") {
          setMenuOpen(false);
          if (devActive) {
            setDevActive(false);
            setVariant(previousVariantRef.current);
            setNarrativeLines((prev) => [...prev, "[Exiting Dev Mode]", ""]);
          } else {
            previousVariantRef.current = variant;
            setDevActive(true);
            setVariant("dev");
            setNarrativeLines((prev) => [...prev, "[Dev Mode \u2014 type to inspect, ESC to exit]", ""]);
          }
        }
        return;
      }
      return;
    }

    // Tab: cycle player
    if (key.tab && gameStateRef.current) {
      const next = switchToNextPlayer(gameStateRef.current);
      setActivePlayerIndex(next.index);
      return;
    }

    // Scroll keys
    if (key.pageUp || key.pageDown) {
      const step = scrollAmount(rows);
      narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
      return;
    }
    if (!inputValue && (input === "+" || input === "-")) {
      const step = scrollAmount(rows);
      narrativeRef.current?.scrollBy(input === "-" ? -step : step);
      return;
    }

    // Text input
    if (key.return && inputValue.trim()) {
      const text = inputValue.trim();
      setInputValue("");
      if (engineRef.current && gameStateRef.current) {
        const active = getActivePlayer(gameStateRef.current);
        setNarrativeLines((prev) => [...prev, "", `> ${active.characterName}: ${text}`, ""]);
        engineRef.current.processInput(active.characterName, text);
      }
      return;
    }

    handleTextKey(input, key);
  });

  // --- Render ---
  const gs = gameStateRef.current;
  const players = gs ? getPlayerEntries(gs) : [{ name: "Player", isAI: false }];
  const activeChar = gs ? getActivePlayer(gs).characterName : "Player";

  const modalHeight = (() => {
    if (!activeModal) return 0;
    switch (activeModal.kind) {
      case "choice":
        return activeModal.choices.length + 5 + 2;
      case "dice":
        return 8 + 2;
      case "recap":
        return Math.min(activeModal.lines.length + 2, Math.floor(rows / 2));
      default:
        return 0;
    }
  })();
  const layoutRows = rows - modalHeight;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Layout
        dimensions={{ columns: cols, rows: layoutRows }}
        style={style}
        variant={variant}
        narrativeLines={narrativeLines}
        modelineText={modelineOverride ?? `${costTracker.current.formatTerse()} | ${campaignName}`}
        inputValue={inputValue}
        activeCharacterName={activeChar}
        players={players}
        activePlayerIndex={activePlayerIndex}
        campaignName={campaignName}
        resources={resources}
        turnHolder={activeChar}
        engineState={engineState}
        quoteColor={gameStateRef.current?.config.players[activePlayerIndex]?.color ?? "#ffffff"}
        narrativeRef={narrativeRef}
      />
      {activeModal?.kind === "choice" && (
        <ChoiceModal
          variant={style.variants[variant]}
          width={cols}
          prompt={activeModal.prompt}
          choices={activeModal.choices}
          selectedIndex={choiceIndex}
        />
      )}
      {activeModal?.kind === "dice" && (
        <DiceRollModal
          variant={style.variants[variant]}
          width={cols}
          expression={activeModal.expression}
          rolls={activeModal.rolls}
          kept={activeModal.kept}
          total={activeModal.total}
          reason={activeModal.reason}
        />
      )}
      {activeModal?.kind === "recap" && (
        <SessionRecapModal
          variant={style.variants[variant]}
          width={cols}
          lines={activeModal.lines}
        />
      )}
      {activeModal?.kind === "character_sheet" && (
        <CharacterSheetModal
          variant={style.variants[variant]}
          width={cols}
          height={rows}
          content={activeModal.content}
          scrollRef={modalScrollRef}
        />
      )}
      {menuOpen && (
        <GameMenu
          variant={style.variants[variant]}
          width={cols}
          height={rows}
          selectedIndex={menuIndex}
          oocActive={oocActive}
          devModeEnabled={devModeEnabled}
          devActive={devActive}
        />
      )}
    </Box>
  );
}
