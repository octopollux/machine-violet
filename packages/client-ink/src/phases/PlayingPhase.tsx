/**
 * PlayingPhase — client-side game interaction.
 *
 * In the two-tier architecture, this component is dramatically simpler
 * than the monolith version. All game logic lives on the server:
 *
 * - Player input → POST /session/turn/contribute
 * - Slash commands → POST /session/command/:name
 * - Modal responses → POST /session/modal/:id/respond
 * - OOC/Dev mode → POST /session/command/ooc or /dev (server manages session)
 * - Narrative, modals, state → arrive via WebSocket events
 *
 * The component just renders what the server says and sends what the player types.
 */
import React, { useState, useRef, useCallback } from "react";
import { useInput, Box } from "ink";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, narrativeRows, choiceRowBudget } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { Layout } from "../tui/layout.js";
import {
  ChoiceOverlay, DESCRIPTION_ROWS, GameMenu, ApiErrorModal,
  CharacterSheetModal, CompendiumModal, PlayerNotesModal, SwatchModal,
} from "../tui/modals/index.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { useGameContext } from "../tui/game-context.js";

export function PlayingPhase() {
  const {
    apiClient,
    narrativeLines, setNarrativeLines,
    theme,
    campaignName, activePlayerIndex,
    engineState, toolGlyphs, resources, modelines,
    activeModal, setActiveModal,
    mode, stateSnapshot,
    retryOverlay,
    onReturnToMenu,
  } = useGameContext();
  const { columns: cols, rows } = useTerminalSize();
  const tooSmall = cols < MIN_COLUMNS || rows < MIN_ROWS;

  // Local state
  const [resetKey, setResetKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const clearInput = useCallback(() => setResetKey((k) => k + 1), []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);

  // Whether TextInput should be disabled
  const textInputDisabled =
    !!activeModal ||
    !!retryOverlay ||
    menuOpen ||
    engineState === "dm_thinking" ||
    engineState === "tool_running";

  // Resolve player info from state snapshot
  const players = stateSnapshot?.players?.map((p) => ({
    name: p.character,
    isAI: p.type === "ai",
  })) ?? [{ name: "Player", isAI: false }];
  const activeChar = players[activePlayerIndex]?.name ?? "Player";

  // --- Submit handler ---
  const handleSubmit = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text) return;

    // Slash commands → REST
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? undefined : text.slice(spaceIdx + 1).trim();

      setNarrativeLines((prev) => [...prev, { kind: "system", text: `/${name}${args ? " " + args : ""}` }]);

      try {
        await apiClient.command(name, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Error: ${msg}]` }]);
      }
      clearInput();
      return;
    }

    // Regular input → contribute to current turn
    setNarrativeLines((prev) => [
      ...prev,
      { kind: "separator", text: "" },
      { kind: "player", text: `[${activeChar}] ${text}` },
      { kind: "dm", text: "" },
    ]);

    try {
      await apiClient.contribute(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Error: ${msg}]` }]);
    }

    clearInput();
  }, [apiClient, activeChar, setNarrativeLines, clearInput]);

  // --- Choice selection ---
  const handleChoiceSelect = useCallback(async (choice: string) => {
    setActiveModal(null);

    // Send choice as a turn contribution
    try {
      await apiClient.contribute(choice);
    } catch {
      // Error handling via WS error events
    }
  }, [apiClient, setActiveModal]);

  const handleChoiceDismiss = useCallback(() => setActiveModal(null), [setActiveModal]);

  const handleNarrativeScroll = useCallback((direction: number) => {
    const step = scrollAmount(rows);
    narrativeRef.current?.scrollBy(direction < 0 ? -step : step);
  }, [rows]);

  // --- Menu ---
  const handleMenuSelect = useCallback(async (item: string) => {
    setMenuOpen(false);
    if (item === "Resume") return;
    if (item === "Save & Exit" || item === "End Session") {
      try { await apiClient.endSession(); } catch { /* ignore */ }
      onReturnToMenu();
    } else if (item === "OOC Mode") {
      await apiClient.command("ooc");
    } else if (item === "Dev Mode") {
      await apiClient.command("dev");
    } else if (item === "Character Sheet") {
      try {
        const { content } = await apiClient.getCharacterSheet(activeChar);
        setActiveModal({ kind: "character_sheet", content } as never);
      } catch { setActiveModal({ kind: "character_sheet", content: "(No character sheet found)" } as never); }
    } else if (item === "Compendium") {
      try {
        const { data } = await apiClient.getCompendium();
        setActiveModal({ kind: "compendium", data } as never);
      } catch { /* ignore */ }
    } else if (item === "Player Notes") {
      try {
        const { content } = await apiClient.getNotes();
        setActiveModal({ kind: "notes", content } as never);
      } catch { setActiveModal({ kind: "notes", content: "" } as never); }
    } else if (item === "Color Swatch") {
      setActiveModal({ kind: "swatch" } as never);
    } else if (item === "Settings") {
      // TODO: campaign settings modal
    }
  }, [apiClient, onReturnToMenu, activeChar, setActiveModal]);

  // --- Input handling ---
  useInput((_input, key) => {
    // Triple-ESC reset
    if (key.escape) {
      const now = Date.now();
      escTimestamps.current.push(now);
      escTimestamps.current = escTimestamps.current.filter((t) => now - t <= 1500);
      if (escTimestamps.current.length >= 3) {
        escTimestamps.current = [];
        setActiveModal(null);
        setMenuOpen(false);
        if (mode === "ooc" || mode === "dev") {
          apiClient.command("exit_mode").catch(() => { /* no-op */ });
        }
        return;
      }
    }

    if (retryOverlay || activeModal || menuOpen) return;

    // In OOC/Dev mode: ESC exits
    if (mode === "ooc" || mode === "dev") {
      if (key.escape) {
        apiClient.command("exit_mode").catch(() => { /* no-op */ });
        return;
      }
    }

    // ESC opens game menu
    if (key.escape) {
      setMenuOpen(true);
      return;
    }

    // Scroll keys
    if (key.pageUp || key.pageDown) {
      const step = scrollAmount(rows);
      narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
    }
  });

  // --- Render ---
  if (tooSmall) {
    return <TerminalTooSmall columns={cols} rows={rows} />;
  }

  // Modal height calculation
  const modalHeight = (() => {
    if (!activeModal) return 0;
    if ("kind" in activeModal && activeModal.kind === "dice") return 10;
    if ("type" in activeModal && activeModal.type === "dice-roll") return 10;
    return 0;
  })();
  const layoutRows = rows - modalHeight;

  const tier = getViewportTier({ columns: cols, rows: layoutRows });
  const visibleElements = getVisibleElements(tier);
  const narRows = narrativeRows(layoutRows, visibleElements, false, theme.asset.height, players.length);
  const conversationPaneTop = visibleElements.topFrame ? theme.asset.height : 0;

  // Active modal data (supports both old ActiveModal and new Modal format)
  const am = activeModal as Record<string, unknown> | null;

  // Choice overlay (from either old ActiveModal or new Modal format)
  const isChoice = activeModal &&
    (("kind" in activeModal && activeModal.kind === "choice") ||
     ("type" in activeModal && activeModal.type === "choice"));

  const choiceData = isChoice ? activeModal as { prompt?: string; choices?: string[]; descriptions?: string[] } : null;

  const choiceOverlay = choiceData ? (
    <ChoiceOverlay
      width={cols - 4}
      prompt={choiceData.prompt ?? ""}
      choices={choiceData.choices ?? []}
      descriptions={choiceData.descriptions}
      maxChoiceRows={choiceRowBudget(visibleElements, 1, false, DESCRIPTION_ROWS)}
      initialIndex={0}
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
        narrativeRef={narrativeRef}
        mouseScrollOverrideRef={modalScrollRef}
        hideInputLine={!!isChoice}
        playerPaneOverlay={choiceOverlay}
      />
      {retryOverlay && (
        <ApiErrorModal theme={theme} width={cols} height={rows} overlay={retryOverlay} />
      )}
      {am?.kind === "character_sheet" && (
        <CharacterSheetModal
          theme={theme}
          width={cols}
          height={narRows}
          content={String(am.content ?? "")}
          onDismiss={() => setActiveModal(null)}
          scrollRef={modalScrollRef}
          topOffset={conversationPaneTop}
        />
      )}
      {am?.kind === "compendium" && (
        <CompendiumModal
          theme={theme}
          width={cols}
          height={narRows}
          data={am.data as never}
          onClose={() => setActiveModal(null)}
          topOffset={conversationPaneTop}
        />
      )}
      {am?.kind === "notes" && (
        <PlayerNotesModal
          theme={theme}
          width={cols}
          height={narRows}
          initialContent={String(am.content ?? "")}
          onSave={(content) => {
            apiClient.saveNotes(content).catch(() => { /* no-op */ });
          }}
          onClose={() => setActiveModal(null)}
          topOffset={conversationPaneTop}
        />
      )}
      {am?.kind === "swatch" && (
        <SwatchModal
          theme={theme}
          width={cols}
          height={narRows}
          topOffset={conversationPaneTop}
          onDismiss={() => setActiveModal(null)}
        />
      )}
      {menuOpen && (
        <GameMenu
          theme={theme}
          width={cols}
          height={rows}
          oocActive={mode === "ooc"}
          devModeEnabled={true}
          devActive={mode === "dev"}
          tokenSummary=""
          onSelect={handleMenuSelect}
          onDismiss={() => setMenuOpen(false)}
        />
      )}
    </Box>
  );
}
