import React, { useState, useRef, useMemo, useCallback } from "react";
import { useInput, useStdout, Box } from "ink";
import { appendDelta } from "../tui/narrative-helpers.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount } from "../tui/components/index.js";
import { Layout } from "../tui/layout.js";
import { ChoiceModal, DiceRollModal, SessionRecapModal, GameMenu, CharacterSheetModal, ApiErrorModal, getMenuItems } from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "../agents/player-manager.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";
import { useGameContext } from "../tui/game-context.js";

export function PlayingPhase() {
  const {
    engineRef, gameStateRef, clientRef, costTracker,
    narrativeLines, setNarrativeLines,
    style, variant, setVariant,
    campaignName, activePlayerIndex, setActivePlayerIndex,
    engineState, resources, modelines,
    activeModal, setActiveModal,
    choiceIndex, setChoiceIndex,
    activeSession, setActiveSession, previousVariantRef,
    devModeEnabled,
    retryOverlay,
    dispatchTuiCommand, onShutdown, onEndSession, onRecapDismissed,
  } = useGameContext();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  // Local state — only used within playing phase input/render
  const [resetKey, setResetKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [modeBusy, setModeBusy] = useState(false);
  const [customInputMode, setCustomInputMode] = useState(false);
  const [customInputResetKey, setCustomInputResetKey] = useState(0);

  const clearInput = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);

  const menuItems = useMemo(() => getMenuItems(devModeEnabled), [devModeEnabled]);

  // Whether TextInput should be disabled
  const textInputDisabled =
    !!(activeModal && activeModal.kind === "dice") ||
    !!activeModal ||
    !!retryOverlay ||
    menuOpen ||
    (!!activeSession && modeBusy);

  // --- Submit handler for TextInput ---
  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();

    if (activeSession) {
      // Any non-DM mode (OOC, Dev, future modes)
      setNarrativeLines((prev) => [...prev, { kind: "player", text: `> ${text}` }, { kind: "dm", text: "" }]);
      setModeBusy(true);
      activeSession.send(text, (delta) => {
        setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
      }).then((result) => {
        setModeBusy(false);
        setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);
        costTracker.current?.record(result.usage, activeSession.tier);
      }).catch((err: unknown) => {
        setModeBusy(false);
        const msg = err instanceof Error ? err.message : String(err);
        setNarrativeLines((prev) => [...prev, { kind: "system", text: `[${activeSession.label} error: ${msg}]` }, { kind: "dm", text: "" }]);
      });
    } else {
      // DM mode
      if (engineRef.current && gameStateRef.current) {
        const active = getActivePlayer(gameStateRef.current);
        setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }, { kind: "player", text: `> ${active.characterName}: ${text}` }, { kind: "dm", text: "" }]);
        engineRef.current.processInput(active.characterName, text);
      }
    }

    clearInput();
  }, [activeSession, clearInput]);

  const handleCustomChoiceSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();
    setActiveModal(null);
    setChoiceIndex(0);
    setCustomInputMode(false);
    setCustomInputResetKey((k) => k + 1);
    if (engineRef.current && gameStateRef.current) {
      const active = getActivePlayer(gameStateRef.current);
      setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }, { kind: "player", text: `> ${active.characterName}: ${text}` }, { kind: "dm", text: "" }]);
      engineRef.current.processInput(active.characterName, text);
    }
  }, []);

  // Helper to exit active session mode
  const exitActiveSession = useCallback(() => {
    if (!activeSession) return;
    const label = activeSession.label;
    setActiveSession(null);
    setVariant(previousVariantRef.current);
    setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Exiting ${label} Mode]` }, { kind: "dm", text: "" }]);
  }, [activeSession, setActiveSession, setVariant, previousVariantRef, setNarrativeLines]);

  // --- Input handling (modals, menus, scroll — TextInput handles text editing) ---
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
        setCustomInputMode(false);
        setCustomInputResetKey((k) => k + 1);
        setMenuOpen(false);
        setMenuIndex(0);
        if (activeSession) {
          exitActiveSession();
        }
        return;
      }
    }

    // Retry overlay: block all input (triple-ESC above still works)
    if (retryOverlay) return;

    // Dice modal: any key dismisses
    if (activeModal && activeModal.kind === "dice") {
      setActiveModal(null);
      return;
    }

    // Scrollable modals (character sheet, recap)
    if (activeModal && (activeModal.kind === "character_sheet" || activeModal.kind === "recap")) {
      if (key.escape || key.return) {
        const wasRecap = activeModal.kind === "recap";
        setActiveModal(null);
        if (wasRecap) onRecapDismissed();
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
      const step = scrollAmount(rows);

      if (customInputMode) {
        // Custom input active — only intercept navigation/scroll, let InlineTextInput handle the rest
        if (key.escape) {
          setCustomInputMode(false);
          return;
        }
        if (key.upArrow) {
          setCustomInputMode(false);
          setCustomInputResetKey((k) => k + 1);
          setChoiceIndex(activeModal.choices.length - 1);
          return;
        }
        if (key.pageUp || key.pageDown) {
          narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
          return;
        }
        // All other keys (including +/-) fall through to InlineTextInput
        return;
      }

      // Normal choice navigation
      if (key.escape) {
        setActiveModal(null);
        setChoiceIndex(0);
        setCustomInputMode(false);
        return;
      }
      if (key.upArrow) {
        setChoiceIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        const totalOptions = activeModal.choices.length + 1;
        setChoiceIndex((i) => {
          const next = Math.min(totalOptions - 1, i + 1);
          if (next === activeModal.choices.length) {
            setCustomInputMode(true);
          }
          return next;
        });
        return;
      }
      if (key.return) {
        if (choiceIndex === activeModal.choices.length) {
          // Enter on the custom input row — activate it
          setCustomInputMode(true);
          return;
        }
        const chosen = activeModal.choices[choiceIndex];
        setActiveModal(null);
        setChoiceIndex(0);
        setCustomInputMode(false);
        if (engineRef.current && gameStateRef.current) {
          const active = getActivePlayer(gameStateRef.current);
          setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }, { kind: "player", text: `> ${active.characterName}: ${chosen}` }, { kind: "dm", text: "" }]);
          engineRef.current.processInput(active.characterName, chosen);
        }
      }
      if (key.pageUp || key.pageDown) {
        narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
      }
      if (input === "+" || input === "-") {
        narrativeRef.current?.scrollBy(input === "-" ? -step : step);
      }
      return;
    }

    // Active session mode (OOC/Dev): ESC exits, busy blocks all keys
    if (activeSession) {
      if (key.escape) {
        exitActiveSession();
        return;
      }
      if (key.pageUp || key.pageDown) {
        const step = scrollAmount(rows);
        narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
        return;
      }
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
        } else if (item === "Save & Exit") {
          setMenuOpen(false);
          onShutdown();
        } else if (item === "End Session") {
          setMenuOpen(false);
          onEndSession();
        } else if (item === "Character Sheet") {
          setMenuOpen(false);
          const gs = gameStateRef.current;
          if (gs) {
            const active = getActivePlayer(gs);
            dispatchTuiCommand({ type: "show_character_sheet", character: active.characterName });
          }
        } else if (item === "OOC Mode") {
          setMenuOpen(false);
          if ((activeSession as null | { label: string })?.label === "OOC") {
            exitActiveSession();
          } else {
            if (clientRef.current && gameStateRef.current) {
              previousVariantRef.current = variant;
              const gs = gameStateRef.current;
              const engine = engineRef.current;
              const sm = engine?.getSceneManager();
              setActiveSession(createOOCSession(clientRef.current, {
                campaignName: gs.config.name,
                previousVariant: variant,
                config: gs.config,
                sessionState: sm?.getSessionState(),
                repo: engine?.getRepo() ?? undefined,
                fileIO: sm?.getFileIO(),
                campaignRoot: gs.campaignRoot,
              }));
              setVariant("ooc");
              setNarrativeLines((prev) => [...prev, { kind: "system", text: "[OOC Mode \u2014 type to chat, ESC to exit]" }, { kind: "dm", text: "" }]);
            }
          }
        } else if (item === "Dev Mode") {
          setMenuOpen(false);
          if ((activeSession as null | { label: string })?.label === "Dev") {
            exitActiveSession();
          } else {
            if (clientRef.current && gameStateRef.current) {
              previousVariantRef.current = variant;
              const gs = gameStateRef.current;
              setActiveSession(createDevSession(clientRef.current, {
                campaignName: gs.config.name,
                gameStateSummary: summarizeGameState(gs),
                gameState: gs,
                fileIO: engineRef.current?.getSceneManager().getFileIO(),
                sceneManager: engineRef.current?.getSceneManager(),
                repo: engineRef.current?.getRepo() ?? undefined,
              }));
              setVariant("dev");
              setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Dev Mode \u2014 type to inspect, ESC to exit]" }, { kind: "dm", text: "" }]);
            }
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
  });

  // --- Render ---
  const gs = gameStateRef.current;
  const players = gs ? getPlayerEntries(gs) : [{ name: "Player", isAI: false }];
  const activeChar = gs ? getActivePlayer(gs).characterName : "Player";

  const modalHeight = (() => {
    if (!activeModal) return 0;
    switch (activeModal.kind) {
      case "choice":
        return activeModal.choices.length + 1 + 5 + 2; // +1 for "Enter your own" row
      case "dice":
        return 8 + 2;
      case "recap":
        return 0; // CenteredModal uses absolute positioning
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
        modelineText={modelines[activeChar] ?? campaignName}
        activeCharacterName={activeChar}
        inputIsDisabled={textInputDisabled}
        inputResetKey={resetKey}
        onInputSubmit={handleSubmit}
        players={players}
        activePlayerIndex={activePlayerIndex}
        campaignName={campaignName}
        resources={resources}
        turnHolder={activeChar}
        engineState={engineState}
        quoteColor="#ffffff"
        playerColor={gameStateRef.current?.config.players[activePlayerIndex]?.color}
        turnIndicatorColor={engineState === "waiting_input" ? gameStateRef.current?.config.players[activePlayerIndex]?.color : undefined}
        narrativeRef={narrativeRef}
        hideInputLine={activeModal?.kind === "choice"}
      />
      {activeModal?.kind === "choice" && (
        <ChoiceModal
          variant={style.variants[variant]}
          width={cols}
          prompt={activeModal.prompt}
          choices={activeModal.choices}
          selectedIndex={choiceIndex}
          showCustomInput
          customInputActive={customInputMode}
          customInputResetKey={customInputResetKey}
          onCustomInputSubmit={handleCustomChoiceSubmit}
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
          height={rows}
          lines={activeModal.lines}
          scrollRef={modalScrollRef}
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
      {retryOverlay && (
        <ApiErrorModal
          variant={style.variants[variant]}
          width={cols}
          height={rows}
          overlay={retryOverlay}
        />
      )}
      {menuOpen && (
        <GameMenu
          variant={style.variants[variant]}
          width={cols}
          height={rows}
          selectedIndex={menuIndex}
          oocActive={activeSession?.label === "OOC"}
          devModeEnabled={devModeEnabled}
          devActive={activeSession?.label === "Dev"}
          tokenSummary={costTracker.current?.formatTokens() ?? ""}
        />
      )}
    </Box>
  );
}
