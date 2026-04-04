/**
 * PlayingPhase — client-side game interaction.
 *
 * In the two-tier architecture, this component is dramatically simpler
 * than the monolith version. All game logic lives on the server:
 *
 * - Player input → POST /session/turn/contribute
 * - Slash commands → POST /session/command/:name
 * - Choice responses → POST /session/choice/respond
 * - OOC/Dev mode → POST /session/command/ooc or /dev (server manages session)
 * - Narrative, choices, state → arrive via WebSocket events
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
  CenteredModal, CharacterPane,
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
    currentTurn,
    activeChoices, setActiveChoices,
    activeModal, setActiveModal,
    mode, stateSnapshot,
    devModeEnabled,
    showVerbose,
    retryOverlay,
    onReturnToMenu,
  } = useGameContext();
  const { columns: cols, rows } = useTerminalSize();
  const tooSmall = cols < MIN_COLUMNS || rows < MIN_ROWS;

  // Local state
  const [resetKey, setResetKey] = useState(0);
  const [pendingInput, setPendingInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [tokenSummary, setTokenSummary] = useState("");
  const [characterPaneOpen, setCharacterPaneOpen] = useState(false);

  const clearInput = useCallback(() => { setPendingInput(""); setResetKey((k) => k + 1); }, []);
  /** Reset the input but pre-fill it with text (e.g. after a rejected contribution). */
  const restoreInput = useCallback((text: string) => { setPendingInput(text); setResetKey((k) => k + 1); }, []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);

  // Whether TextInput should be disabled.
  // Never block on engine state — the server rejects input if inappropriate.
  // This prevents the client from getting permanently wedged.
  const textInputDisabled =
    !!activeChoices ||
    !!activeModal ||
    !!retryOverlay ||
    menuOpen;

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

    // Regular input → contribute to current turn.
    // Tag optimistic lines so we can remove exactly these on rejection,
    // even if other lines (WS events, other players) arrived in between.
    const tag = `optimistic-${Date.now()}`;
    setNarrativeLines((prev) => [
      ...prev,
      { kind: "separator", text: "---", tag },
      { kind: "player", text: `[${activeChar}] ${text}`, tag },
      { kind: "dm", text: "", tag },
    ]);

    try {
      await apiClient.contribute(text, {
        campaignId: currentTurn?.campaignId,
        turnSeq: currentTurn?.seq,
      });
      clearInput();
    } catch {
      // Contribution rejected — remove only our optimistic lines
      // and restore the player's text to the input box so they can resend.
      setNarrativeLines((prev) => prev.filter((l) => l.tag !== tag));
      restoreInput(text);
    }
  }, [apiClient, activeChar, currentTurn, setNarrativeLines, clearInput, restoreInput]);

  // --- Choice selection ---
  const handleChoiceSelect = useCallback(async (choice: string) => {
    const choices = activeChoices;
    setActiveChoices(null);

    // Echo the player's choice into the narrative (separator + player line)
    const tag = `optimistic-${Date.now()}`;
    setNarrativeLines((prev) => [
      ...prev,
      { kind: "separator", text: "---", tag },
      { kind: "player", text: `[${activeChar}] ${choice}`, tag },
      { kind: "dm", text: "", tag },
    ]);

    // Setup choices are resolved via the choice respond endpoint
    if (choices?.id === "setup-choice") {
      try {
        await apiClient.respondToChoice(choice);
      } catch { /* no-op */ }
      return;
    }

    // Gameplay choices — contribute to the current turn
    try {
      await apiClient.contribute(choice, {
        campaignId: currentTurn?.campaignId,
        turnSeq: currentTurn?.seq,
      });
    } catch {
      // Contribution rejected — remove optimistic lines
      setNarrativeLines((prev) => prev.filter((l) => l.tag !== tag));
    }
  }, [apiClient, activeChoices, setActiveChoices, activeChar, currentTurn, setNarrativeLines]);

  const handleChoiceDismiss = useCallback(() => setActiveChoices(null), [setActiveChoices]);

  const handleNarrativeScroll = useCallback((direction: number) => {
    const step = scrollAmount(rows);
    narrativeRef.current?.scrollBy(direction < 0 ? -step : step);
  }, [rows]);

  // --- Menu ---
  const handleMenuSelect = useCallback(async (item: string) => {
    setMenuOpen(false);
    if (item === "Resume") return;
    if (item === "Save & Exit" || item === "End Session") {
      onReturnToMenu(); // returnToMenu handles endSession + state reset
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
        setActiveChoices(null);
        setActiveModal(null);
        setMenuOpen(false);
        setCharacterPaneOpen(false);
        if (mode === "ooc" || mode === "dev") {
          apiClient.command("exit_mode").catch(() => { /* no-op */ });
        }
        return;
      }
    }

    if (retryOverlay || activeChoices || activeModal || menuOpen) return;

    // Tab: toggle character pane
    if (key.tab) {
      setCharacterPaneOpen((prev) => !prev);
      return;
    }

    // In OOC/Dev mode: ESC exits
    if (mode === "ooc" || mode === "dev") {
      if (key.escape) {
        apiClient.command("exit_mode").catch(() => { /* no-op */ });
        return;
      }
    }

    // ESC: dismiss character pane first, then open menu
    if (key.escape) {
      if (characterPaneOpen) {
        setCharacterPaneOpen(false);
        return;
      }
      setMenuOpen(true);
      apiClient.getCost().then(({ formatted }) => setTokenSummary(formatted)).catch(() => { /* no-op */ });
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

  const tier = getViewportTier({ columns: cols, rows });
  const visibleElements = getVisibleElements(tier);
  const hasDescriptions = (activeChoices?.descriptions?.length ?? 0) > 0;
  const descExtraHeight = hasDescriptions ? DESCRIPTION_ROWS : 0;
  const narRows = narrativeRows(rows, visibleElements, false, theme.asset.height, players.length, descExtraHeight);
  const conversationPaneTop = visibleElements.topFrame ? theme.asset.height : 0;

  // Active client-driven modal data (character sheet, compendium, notes, swatch)
  const am = activeModal as Record<string, unknown> | null;

  // Server-driven choices (rendered inline in Player Pane, not as a modal)
  const choiceOverlay = activeChoices ? (
    <ChoiceOverlay
      width={cols - 4}
      prompt={activeChoices.prompt ?? ""}
      choices={activeChoices.choices ?? []}
      descriptions={activeChoices.descriptions}
      maxChoiceRows={choiceRowBudget(visibleElements, 1, hasDescriptions, DESCRIPTION_ROWS)}
      initialIndex={0}
      onSelect={handleChoiceSelect}
      onDismiss={handleChoiceDismiss}
      onNarrativeScroll={handleNarrativeScroll}
    />
  ) : undefined;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Layout
        dimensions={{ columns: cols, rows }}
        theme={theme}
        narrativeLines={narrativeLines}
        modelineText={modelines[activeChar] ?? campaignName}
        activeCharacterName={activeChar}
        inputIsDisabled={textInputDisabled}
        inputDefaultValue={pendingInput}
        inputResetKey={resetKey}
        onInputSubmit={handleSubmit}
        players={players}
        activePlayerIndex={activePlayerIndex}
        campaignName={campaignName}
        resources={resources}
        turnHolder={engineState === "waiting_input" ? activeChar : "DM"}
        engineState={engineState}
        toolGlyphs={toolGlyphs}
        quoteColor="#ffffff"
        playerColor={stateSnapshot?.players?.[activePlayerIndex]?.color}
        playerFrameColor={engineState === "waiting_input" ? stateSnapshot?.players?.[activePlayerIndex]?.color : "#808080"}
        showVerbose={showVerbose}
        narrativeRef={narrativeRef}
        mouseScrollOverrideRef={modalScrollRef}
        hideInputLine={!!activeChoices}
        playerPaneOverlay={choiceOverlay}
        playerPaneExtraHeight={hasDescriptions ? DESCRIPTION_ROWS : 0}
      />
      {characterPaneOpen && (
        <CharacterPane
          theme={theme}
          characterName={activeChar}
          apiClient={apiClient}
          narrativeWidth={cols}
          narrativeHeight={narRows}
          topOffset={conversationPaneTop}
        />
      )}
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
      {am?.kind === "saving" && (
        <CenteredModal
          theme={theme}
          width={cols}
          height={rows}
          title="Saving"
          minWidth={30}
          maxWidth={40}
          lines={["", "  Saving session...", ""]}
          topOffset={conversationPaneTop}
        />
      )}
      {menuOpen && (
        <GameMenu
          theme={theme}
          width={cols}
          height={rows}
          oocActive={mode === "ooc"}
          devModeEnabled={devModeEnabled}
          devActive={mode === "dev"}
          tokenSummary={tokenSummary}
          onSelect={handleMenuSelect}
          onDismiss={() => setMenuOpen(false)}
        />
      )}
    </Box>
  );
}
