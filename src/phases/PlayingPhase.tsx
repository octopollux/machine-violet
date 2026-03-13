import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useInput, Box } from "ink";
import { appendDelta } from "../tui/narrative-helpers.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, narrativeRows } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { Layout } from "../tui/layout.js";
import { stripFormatting } from "../tui/formatting.js";
import { ChoiceOverlay, DESCRIPTION_ROWS, DiceRollModal, SessionRecapModal, GameMenu, CharacterSheetModal, ApiErrorModal, SwatchModal, getMenuItems } from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "../agents/player-manager.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";
import { useGameContext } from "../tui/game-context.js";
import { trySlashCommand } from "../commands/index.js";
import { RollbackCompleteError } from "../teardown.js";

export function PlayingPhase() {
  const {
    engineRef, gameStateRef, clientRef, costTracker,
    narrativeLines, setNarrativeLines,
    theme, variant, setVariant,
    campaignName, activePlayerIndex, setActivePlayerIndex,
    engineState, toolGlyphs, resources, modelines,
    activeModal, setActiveModal,
    choiceIndex, setChoiceIndex,
    activeSession, setActiveSession, previousVariantRef,
    devModeEnabled,
    retryOverlay,
    dispatchTuiCommand, onReturnToMenu, onEndSessionAndReturn,
  } = useGameContext();
  const { columns: cols, rows } = useTerminalSize();
  const tooSmall = cols < MIN_COLUMNS || rows < MIN_ROWS;

  // Sync terminal dimensions to engine for length steering.
  // Compute from base rows (no modal subtraction) — this is the steady-state
  // narrative area the DM should target.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const tier = getViewportTier({ columns: cols, rows });
    const elements = getVisibleElements(tier);
    const narRows = narrativeRows(rows, elements, false, 2, 2);
    engine.setTerminalDims({ columns: cols, rows, narrativeRows: narRows });
  }, [cols, rows, engineRef]);

  // Local state — only used within playing phase input/render
  const [resetKey, setResetKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [modeBusy, setModeBusy] = useState(false);
  const [customInputMode, setCustomInputMode] = useState(false);
  const [customInputResetKey, setCustomInputResetKey] = useState(0);

  // When a choice modal appears with <5 options, default focus lands on "Enter your own"
  // so choiceIndex === choices.length — activate custom input mode to match.
  useEffect(() => {
    if (activeModal?.kind === "choice" && choiceIndex === activeModal.choices.length) {
      setCustomInputMode(true);
    }
  }, [activeModal, choiceIndex]);

  const clearInput = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);
  const oocSummaries = useRef<string[]>([]);

  const menuItems = useMemo(() => getMenuItems(devModeEnabled), [devModeEnabled]);

  // Whether TextInput should be disabled
  const textInputDisabled =
    !!(activeModal && activeModal.kind === "dice") ||
    !!activeModal ||
    !!retryOverlay ||
    menuOpen ||
    (!!activeSession && modeBusy);

  // Helper to exit active session mode.
  // Pass silent=true for agent-initiated exits (END_OOC) to skip the system line.
  const exitActiveSession = useCallback((silent = false) => {
    if (!activeSession) return;
    const label = activeSession.label;
    // Flush accumulated OOC summaries to the engine for injection into the next DM turn
    if (label === "OOC" && oocSummaries.current.length > 0) {
      if (engineRef.current) {
        engineRef.current.setPendingOOCSummary(
          oocSummaries.current.join("\n"),
        );
      }
      oocSummaries.current = [];
    }
    setActiveSession(null);
    setVariant(previousVariantRef.current);
    if (!silent) {
      setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Exiting ${label} Mode]` }, { kind: "dm", text: "" }]);
    }
  }, [activeSession, setActiveSession, setVariant, previousVariantRef, setNarrativeLines, engineRef]);

  // --- Submit handler for TextInput ---
  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();

    if (trySlashCommand(text, {
      engine: engineRef.current,
      gameState: gameStateRef.current,
      client: clientRef.current,
      appendLine: (line) => setNarrativeLines((prev) => [...prev, line]),
      activeSession,
      setActiveSession,
      variant,
      setVariant,
      previousVariant: previousVariantRef.current,
      setPreviousVariant: (v) => { previousVariantRef.current = v; },
      dispatchTuiCommand,
      setActiveModal,
      onReturnToMenu,
    })) {
      clearInput();
      return;
    }

    if (activeSession) {
      setNarrativeLines((prev) => [...prev, { kind: "separator", text: "" }, { kind: "player", text: `> ${text}` }, { kind: "dm", text: "" }]);
      setModeBusy(true);
      activeSession.send(text, (delta) => {
        setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
      }).then((result) => {
        setModeBusy(false);
        setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);
        costTracker.current?.record(result.usage, activeSession.tier);
        // Accumulate OOC summaries for injection into the next DM turn
        if (activeSession.label === "OOC" && result.summary) {
          oocSummaries.current.push(result.summary);
        }
        // Auto-exit if the OOC agent signaled END_OOC
        if (result.endSession) {
          exitActiveSession(true);
          // Forward in-character action to DM if provided
          if (result.playerAction && engineRef.current && gameStateRef.current) {
            const active = getActivePlayer(gameStateRef.current);
            engineRef.current.processInput(active.characterName, result.playerAction);
          }
        }
      }).catch((err: unknown) => {
        setModeBusy(false);
        if (err instanceof RollbackCompleteError) {
          onReturnToMenu();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setNarrativeLines((prev) => [...prev, { kind: "system", text: `[${activeSession.label} error: ${msg}]` }, { kind: "dm", text: "" }]);
      });
    } else {
      if (engineRef.current && gameStateRef.current) {
        const active = getActivePlayer(gameStateRef.current);
        engineRef.current.processInput(active.characterName, text);
      }
    }

    clearInput();
  }, [activeSession, exitActiveSession, clearInput, variant, setActiveSession, setVariant, setNarrativeLines]);

  const handleCustomChoiceSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();
    setActiveModal(null);
    setChoiceIndex(0);
    setCustomInputMode(false);
    setCustomInputResetKey((k) => k + 1);
    if (engineRef.current && gameStateRef.current) {
      const active = getActivePlayer(gameStateRef.current);
      engineRef.current.processInput(active.characterName, text);
    }
  }, []);

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

    // Dice / swatch modal: any key dismisses
    if (activeModal && (activeModal.kind === "dice" || activeModal.kind === "swatch")) {
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
      const step = scrollAmount(rows);

      if (customInputMode) {
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
        return;
      }

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
          setCustomInputMode(true);
          return;
        }
        const chosen = stripFormatting(activeModal.choices[choiceIndex]);
        setActiveModal(null);
        setChoiceIndex(0);
        setCustomInputMode(false);
        if (engineRef.current && gameStateRef.current) {
          const active = getActivePlayer(gameStateRef.current);
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
          onReturnToMenu();
        } else if (item === "End Session") {
          setMenuOpen(false);
          onEndSessionAndReturn();
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
                onTuiCommand: (cmd) => dispatchTuiCommand(cmd),
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
  if (tooSmall) {
    return <TerminalTooSmall columns={cols} rows={rows} />;
  }

  const gs = gameStateRef.current;
  const players = gs ? getPlayerEntries(gs) : [{ name: "Player", isAI: false }];
  const activeChar = gs ? getActivePlayer(gs).characterName : "Player";

  const modalHeight = (() => {
    if (!activeModal) return 0;
    switch (activeModal.kind) {
      case "choice":
        return 0; // choice overlay lives inside the Player Pane
      case "dice":
        return 8 + 2;
      case "recap":
        return 0;
      default:
        return 0;
    }
  })();
  const layoutRows = rows - modalHeight;

  // Compute conversation pane dimensions for modal sizing/centering
  const tier = getViewportTier({ columns: cols, rows: layoutRows });
  const visibleElements = getVisibleElements(tier);
  const narRows = narrativeRows(layoutRows, visibleElements, activeModal?.kind === "choice", theme.asset.height, players.length);
  const conversationPaneTop = visibleElements.topFrame ? theme.asset.height : 0;

  // Build overlay for choice modal (replaces Player Pane content)
  const choiceHasDescriptions = activeModal?.kind === "choice"
    && activeModal.descriptions != null && activeModal.descriptions.length > 0;
  const paneExtraHeight = choiceHasDescriptions ? DESCRIPTION_ROWS : 0;
  const choiceOverlay = activeModal?.kind === "choice" ? (
    <ChoiceOverlay
      width={cols - 4}
      prompt={activeModal.prompt}
      choices={activeModal.choices}
      descriptions={activeModal.descriptions}
      selectedIndex={choiceIndex}
      showCustomInput
      customInputActive={customInputMode}
      customInputResetKey={customInputResetKey}
      onCustomInputSubmit={handleCustomChoiceSubmit}
    />
  ) : undefined;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Layout
        dimensions={{ columns: cols, rows: layoutRows }}
        theme={theme}
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
        toolGlyphs={toolGlyphs}
        quoteColor="#ffffff"
        playerColor={gameStateRef.current?.config.players[activePlayerIndex]?.color}
        turnIndicatorColor={engineState === "waiting_input" ? gameStateRef.current?.config.players[activePlayerIndex]?.color : undefined}
        narrativeRef={narrativeRef}
        hideInputLine={activeModal?.kind === "choice"}
        playerPaneOverlay={choiceOverlay}
        playerPaneExtraHeight={paneExtraHeight}
      />
      {activeModal?.kind === "dice" && (
        <DiceRollModal
          theme={theme}
          width={cols}
          expression={activeModal.expression}
          rolls={activeModal.rolls}
          kept={activeModal.kept}
          total={activeModal.total}
          reason={activeModal.reason}
        />
      )}
      {activeModal?.kind === "swatch" && (
        <SwatchModal theme={theme} width={cols} height={narRows} topOffset={conversationPaneTop} />
      )}
      {activeModal?.kind === "recap" && (
        <SessionRecapModal
          theme={theme}
          width={cols}
          height={narRows}
          lines={activeModal.lines}
          scrollRef={modalScrollRef}
          topOffset={conversationPaneTop}
        />
      )}
      {activeModal?.kind === "character_sheet" && (
        <CharacterSheetModal
          theme={theme}
          width={cols}
          height={narRows}
          content={activeModal.content}
          scrollRef={modalScrollRef}
          topOffset={conversationPaneTop}
        />
      )}
      {retryOverlay && (
        <ApiErrorModal
          theme={theme}
          width={cols}
          height={rows}
          overlay={retryOverlay}
        />
      )}
      {menuOpen && (
        <GameMenu
          theme={theme}
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
