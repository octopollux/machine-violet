import React, { useState, useRef, useMemo, useCallback } from "react";
import { useInput, useStdout, Box } from "ink";
import { appendDelta } from "../tui/narrative-helpers.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount } from "../tui/components/index.js";
import { Layout } from "../tui/layout.js";
import { ChoiceModal, DiceRollModal, SessionRecapModal, GameMenu, CharacterSheetModal, getMenuItems } from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "../agents/player-manager.js";
import { enterOOC } from "../agents/subagents/ooc-mode.js";
import { enterDevMode, summarizeGameState } from "../agents/subagents/dev-mode.js";
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
    oocActive, setOocActive, previousVariantRef,
    devModeEnabled, devActive, setDevActive,
    dispatchTuiCommand, onShutdown, onEndSession,
  } = useGameContext();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  // Local state — only used within playing phase input/render
  const [resetKey, setResetKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [oocBusy, setOocBusy] = useState(false);
  const [devBusy, setDevBusy] = useState(false);
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
    menuOpen ||
    (devActive && devBusy) ||
    (oocActive && oocBusy);

  // --- Submit handler for TextInput ---
  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();

    if (devActive) {
      setNarrativeLines((prev) => [...prev, { kind: "player", text: `> ${text}` }, { kind: "dm", text: "" }]);
      if (clientRef.current && gameStateRef.current) {
        const gs = gameStateRef.current;
        const fileIO = engineRef.current?.getSceneManager().getFileIO();
        setDevBusy(true);
        enterDevMode(clientRef.current, text, {
          campaignName: gs.config.name,
          gameStateSummary: summarizeGameState(gs),
          gameState: gs,
          fileIO,
          sceneManager: engineRef.current?.getSceneManager(),
          repo: engineRef.current?.getRepo() ?? undefined,
        }, (delta) => {
          setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
        }).then((result) => {
          setDevBusy(false);
          setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);
          costTracker.current.record(result.usage, "medium");
        }).catch(() => {
          setDevBusy(false);
          setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Dev mode error]" }, { kind: "dm", text: "" }]);
        });
      }
    } else if (oocActive) {
      setNarrativeLines((prev) => [...prev, { kind: "player", text: `> ${text}` }, { kind: "dm", text: "" }]);
      if (clientRef.current && gameStateRef.current) {
        const gs = gameStateRef.current;
        setOocBusy(true);
        enterOOC(clientRef.current, text, {
          campaignName: gs.config.name,
          previousVariant: previousVariantRef.current,
          repo: engineRef.current?.getRepo() ?? undefined,
        }, (delta) => {
          setNarrativeLines((prev) => appendDelta(prev, delta, "dm"));
        }).then((result) => {
          setOocBusy(false);
          setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }]);
          costTracker.current.record(result.usage, "medium");
        }).catch(() => {
          setOocBusy(false);
          setNarrativeLines((prev) => [...prev, { kind: "system", text: "[OOC error]" }, { kind: "dm", text: "" }]);
        });
      }
    } else {
      if (engineRef.current && gameStateRef.current) {
        const active = getActivePlayer(gameStateRef.current);
        setNarrativeLines((prev) => [...prev, { kind: "dm", text: "" }, { kind: "player", text: `> ${active.characterName}: ${text}` }, { kind: "dm", text: "" }]);
        engineRef.current.processInput(active.characterName, text);
      }
    }

    clearInput();
  }, [devActive, oocActive, clearInput]);

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

    // Dev mode: ESC exits, busy blocks all keys
    if (devActive) {
      if (key.escape) {
        setDevActive(false);
        setVariant(previousVariantRef.current);
        setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Exiting Dev Mode]" }, { kind: "dm", text: "" }]);
        return;
      }
      if (key.pageUp || key.pageDown) {
        const step = scrollAmount(rows);
        narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
        return;
      }
      return;
    }

    // OOC mode: ESC exits, busy blocks all keys
    if (oocActive) {
      if (key.escape) {
        setOocActive(false);
        setVariant(previousVariantRef.current);
        setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Exiting OOC Mode]" }, { kind: "dm", text: "" }]);
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
          if (oocActive) {
            setOocActive(false);
            setVariant(previousVariantRef.current);
            setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Exiting OOC Mode]" }, { kind: "dm", text: "" }]);
          } else {
            previousVariantRef.current = variant;
            setOocActive(true);
            setVariant("ooc");
            setNarrativeLines((prev) => [...prev, { kind: "system", text: "[OOC Mode \u2014 type to chat, ESC to exit]" }, { kind: "dm", text: "" }]);
          }
        } else if (item === "Dev Mode") {
          setMenuOpen(false);
          if (devActive) {
            setDevActive(false);
            setVariant(previousVariantRef.current);
            setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Exiting Dev Mode]" }, { kind: "dm", text: "" }]);
          } else {
            previousVariantRef.current = variant;
            setDevActive(true);
            setVariant("dev");
            setNarrativeLines((prev) => [...prev, { kind: "system", text: "[Dev Mode \u2014 type to inspect, ESC to exit]" }, { kind: "dm", text: "" }]);
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
          tokenSummary={costTracker.current.formatTokens()}
        />
      )}
    </Box>
  );
}
