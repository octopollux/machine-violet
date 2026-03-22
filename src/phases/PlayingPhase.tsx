import React, { useState, useRef, useCallback, useEffect } from "react";
import { useInput, Box } from "ink";
import { appendDelta } from "../tui/narrative-helpers.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall, buildModelineDisplay, splitModeline } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, narrativeRows, choiceRowBudget } from "../tui/responsive.js";
import { getActivity } from "../tui/activity.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { Layout } from "../tui/layout.js";
import { ChoiceOverlay, DESCRIPTION_ROWS, DiceRollModal, SessionRecapModal, RollbackSummaryModal, GameMenu, CharacterSheetModal, CompendiumModal, PlayerNotesModal, ApiErrorModal, SwatchModal, CampaignSettingsModal } from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "../agents/player-manager.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession, summarizeGameState } from "../agents/subagents/dev-mode.js";
import { useGameContext } from "../tui/game-context.js";
import { campaignPaths } from "../tools/filesystem/index.js";
import { emptyCompendium, parseCompendiumOutput } from "../agents/subagents/compendium-updater.js";
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
    activeSession, setActiveSession, previousVariantRef,
    devModeEnabled,
    retryOverlay,
    dispatchTuiCommand, onReturnToMenu, onRollbackReturn, onEndSessionAndReturn,
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
  const [modeBusy, setModeBusy] = useState(false);
  const [campaignSettingsOpen, setCampaignSettingsOpen] = useState(false);

  const clearInput = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);
  const oocSummaries = useRef<string[]>([]);

  // Whether TextInput should be disabled
  const textInputDisabled =
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
    // Empty Enter retries the last failed DM turn (if one is pending)
    if (!value.trim()) {
      if (engineRef.current?.hasPendingRetry()) {
        engineRef.current.retryLastTurn();
        clearInput();
      }
      return;
    }
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
      onRollbackComplete: (summary: string) => setActiveModal({ kind: "rollback", summary }),
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
        const ct = costTracker.current;
        if (ct) {
          ct.record(result.usage, activeSession.tier);
          engineRef.current?.getPersister()?.persistUsage(ct.getBreakdown());
        }
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
          setActiveModal({ kind: "rollback", summary: err.summary });
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

  // --- Menu dispatch: called by GameMenu when a menu item is selected ---
  const handleMenuSelect = useCallback((item: string) => {
    setMenuOpen(false);
    if (item === "Resume") {
      // just close menu
    } else if (item === "Save & Exit") {
      onReturnToMenu();
    } else if (item === "End Session") {
      onEndSessionAndReturn();
    } else if (item === "Character Sheet") {
      const gs = gameStateRef.current;
      if (gs) {
        const active = getActivePlayer(gs);
        dispatchTuiCommand({ type: "show_character_sheet", character: active.characterName });
      }
    } else if (item === "Compendium") {
      const gs = gameStateRef.current;
      const io = engineRef.current?.getSceneManager().getFileIO();
      if (gs && io) {
        const path = campaignPaths(gs.campaignRoot).compendium;
        io.readFile(path).then((raw: string) => {
          const data = parseCompendiumOutput(raw, emptyCompendium());
          setActiveModal({ kind: "compendium", data });
        }).catch(() => {
          setActiveModal({ kind: "compendium", data: emptyCompendium() });
        });
      } else {
        setActiveModal({ kind: "compendium", data: emptyCompendium() });
      }
    } else if (item === "Player Notes") {
      const gs = gameStateRef.current;
      const io = engineRef.current?.getSceneManager().getFileIO();
      if (gs && io) {
        const path = campaignPaths(gs.campaignRoot).playerNotes;
        io.readFile(path).then((raw: string) => {
          setActiveModal({ kind: "notes", content: raw });
        }).catch(() => {
          setActiveModal({ kind: "notes", content: "" });
        });
      } else {
        setActiveModal({ kind: "notes", content: "" });
      }
    } else if (item === "OOC Mode") {
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
    } else if (item === "Settings") {
      setCampaignSettingsOpen(true);
    } else if (item === "Dev Mode") {
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
  }, [activeSession, exitActiveSession, variant, setActiveSession, setVariant, setNarrativeLines,
    onReturnToMenu, onEndSessionAndReturn, dispatchTuiCommand, setActiveModal,
    engineRef, gameStateRef, clientRef, previousVariantRef, setCampaignSettingsOpen]);

  // --- Choice overlay callbacks ---
  const handleChoiceSelect = useCallback((choice: string) => {
    setActiveModal(null);
    if (engineRef.current && gameStateRef.current) {
      const active = getActivePlayer(gameStateRef.current);
      engineRef.current.processInput(active.characterName, choice);
    }
  }, [setActiveModal, engineRef, gameStateRef]);

  const handleChoiceDismiss = useCallback(() => {
    setActiveModal(null);
  }, [setActiveModal]);

  const handleNarrativeScroll = useCallback((direction: number) => {
    const step = scrollAmount(rows);
    narrativeRef.current?.scrollBy(direction < 0 ? -step : step);
  }, [rows]);

  // --- Input handling — only non-modal keys remain here ---
  useInput((_input, key) => {
    // Triple-ESC reset: 3 ESC presses within 1.5s clears all overlay state
    if (key.escape) {
      const now = Date.now();
      escTimestamps.current.push(now);
      escTimestamps.current = escTimestamps.current.filter((t) => now - t <= 1500);
      if (escTimestamps.current.length >= 3) {
        escTimestamps.current = [];
        setActiveModal(null);
        setMenuOpen(false);
        setCampaignSettingsOpen(false);
        if (activeSession) {
          exitActiveSession();
        }
        return;
      }
    }

    // All overlays handle their own input — block here
    if (retryOverlay) return;
    if (activeModal) return;
    if (campaignSettingsOpen) return;
    if (menuOpen) return;

    // Active session mode (OOC/Dev): ESC exits, PageUp/PageDown scrolls
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

    // ESC opens game menu
    if (key.escape) {
      setMenuOpen(true);
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

  // Compute dynamic max choice rows to fill available Player Pane space
  let choiceMaxRows: number | undefined;
  if (activeModal?.kind === "choice") {
    const activity = getActivity(engineState);
    const actGlyph = visibleElements.activityGlyphInModeline ? activity?.glyph : undefined;
    const mlDisplay = buildModelineDisplay(modelines[activeChar] ?? campaignName, actGlyph);
    const mlLineCount = splitModeline(mlDisplay, cols).length;
    choiceMaxRows = choiceRowBudget(visibleElements, mlLineCount, choiceHasDescriptions, DESCRIPTION_ROWS);
  }

  const choiceOverlay = activeModal?.kind === "choice" ? (
    <ChoiceOverlay
      width={cols - 4}
      prompt={activeModal.prompt}
      choices={activeModal.choices}
      descriptions={activeModal.descriptions}
      accentColor={gameStateRef.current?.config.players[activePlayerIndex]?.color}
      maxChoiceRows={choiceMaxRows}
      initialIndex={activeModal.choices.length < 5 ? activeModal.choices.length : 0}
      onSelect={handleChoiceSelect}
      onDismiss={handleChoiceDismiss}
      onNarrativeScroll={handleNarrativeScroll}
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
        mouseScrollOverrideRef={modalScrollRef}
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
          onDismiss={() => setActiveModal(null)}
        />
      )}
      {activeModal?.kind === "swatch" && (
        <SwatchModal theme={theme} width={cols} height={narRows} topOffset={conversationPaneTop} onDismiss={() => setActiveModal(null)} />
      )}
      {activeModal?.kind === "rollback" && (
        <RollbackSummaryModal
          theme={theme}
          width={cols}
          height={narRows}
          summary={activeModal.summary}
          onDismiss={() => { setActiveModal(null); onRollbackReturn(); }}
          topOffset={conversationPaneTop}
        />
      )}
      {activeModal?.kind === "recap" && (
        <SessionRecapModal
          theme={theme}
          width={cols}
          height={narRows}
          lines={activeModal.lines}
          onDismiss={() => setActiveModal(null)}
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
          onDismiss={() => setActiveModal(null)}
          scrollRef={modalScrollRef}
          topOffset={conversationPaneTop}
        />
      )}
      {activeModal?.kind === "compendium" && (
        <CompendiumModal
          theme={theme}
          width={cols}
          height={narRows}
          data={activeModal.data}
          onClose={() => setActiveModal(null)}
          topOffset={conversationPaneTop}
        />
      )}
      {activeModal?.kind === "notes" && (
        <PlayerNotesModal
          theme={theme}
          width={cols}
          height={narRows}
          initialContent={activeModal.content}
          onSave={(content) => {
            const gs = gameStateRef.current;
            const io = engineRef.current?.getSceneManager().getFileIO();
            if (gs && io) {
              const path = campaignPaths(gs.campaignRoot).playerNotes;
              io.writeFile(path, content);
            }
          }}
          onClose={() => setActiveModal(null)}
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
      {campaignSettingsOpen && gameStateRef.current && (
        <CampaignSettingsModal
          theme={theme}
          width={cols}
          height={rows}
          config={gameStateRef.current.config}
          onDismiss={() => { setCampaignSettingsOpen(false); setMenuOpen(true); }}
        />
      )}
      {menuOpen && (
        <GameMenu
          theme={theme}
          width={cols}
          height={rows}
          oocActive={activeSession?.label === "OOC"}
          devModeEnabled={devModeEnabled}
          devActive={activeSession?.label === "Dev"}
          tokenSummary={costTracker.current?.formatTokens() ?? ""}
          onSelect={handleMenuSelect}
          onDismiss={() => setMenuOpen(false)}
        />
      )}
    </Box>
  );
}
