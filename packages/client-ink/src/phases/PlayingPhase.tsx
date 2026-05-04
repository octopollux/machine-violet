/**
 * PlayingPhase — client-side game interaction.
 *
 * In the two-tier architecture, this component is dramatically simpler
 * than the monolith version. All game logic lives on the server:
 *
 * - Player input → POST /session/turn/contribute (free-form text)
 * - Choice responses → POST /session/turn/contribute with fromChoice=true
 * - Slash commands → POST /session/command/:name
 * - OOC/Dev mode → POST /session/command/ooc or /dev (server manages session)
 * - Narrative, choices, state → arrive via WebSocket events
 *
 * The component just renders what the server says and sends what the player types.
 */
import React, { useState, useRef, useCallback, useMemo } from "react";
import { useInput, Box, useWindowSize } from "ink";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import type { KeyHint } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, narrativeRows, choiceRowBudget } from "../tui/responsive.js";
import { useRawModeGuardian } from "../tui/hooks/useRawModeGuardian.js";
import { Layout } from "../tui/layout.js";
import {
  ChoiceOverlay, DESCRIPTION_ROWS, GameMenu, ApiErrorModal,
  CharacterSheetModal, CompendiumModal, PlayerNotesModal, SwatchModal,
  SessionRecapModal, CenteredModal, CharacterPane, CampaignSettingsModal,
} from "../tui/modals/index.js";
import type { CampaignConfig, ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { useGameContext } from "../tui/game-context.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import { buildTranscriptHtml } from "../commands/transcript.js";
import { openPath, revealInExplorer } from "../commands/open-path.js";

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
    hasKittyProtocol,
    devModeEnabled,
    showVerbose,
    retryOverlay,
    onReturnToMenu,
  } = useGameContext();
  const { columns: cols, rows } = useWindowSize();

  // On Windows without Kitty protocol, periodically refresh raw mode to
  // recover from ConPTY silently corrupting console mode flags.
  // When Kitty is active, CSI-u encoding is unambiguous regardless of
  // console mode, so the guardian is unnecessary.
  useRawModeGuardian({ enabled: !hasKittyProtocol });
  const tooSmall = cols < MIN_COLUMNS || rows < MIN_ROWS;

  // Local state
  const [resetKey, setResetKey] = useState(0);
  const [pendingInput, setPendingInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [tokenSummary, setTokenSummary] = useState("");
  const [characterPaneOpen, setCharacterPaneOpen] = useState(false);
  const [characterSheetCache, setCharacterSheetCache] = useState<string | null>(null);
  const characterSheetCacheCharRef = useRef<string>("");

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

  // Clear character sheet cache when active character changes
  if (activeChar !== characterSheetCacheCharRef.current) {
    characterSheetCacheCharRef.current = activeChar;
    setCharacterSheetCache(null);
  }
  const handleCharacterSheetLoaded = useCallback((content: string | null) => {
    setCharacterSheetCache(content);
  }, []);

  // --- Save transcript handler ---
  const saveTranscript = useCallback(async () => {
    const playerColor = stateSnapshot?.players?.[activePlayerIndex]?.color ?? "#55ff55";
    const separatorColor = themeColor(theme, "separator") ?? "#666666";
    const html = buildTranscriptHtml({
      narrativeLines,
      width: cols,
      campaignName,
      themeAsset: theme.asset,
      separatorColor,
      playerColor,
      quoteColor: "#ffffff",
    });
    try {
      const { path } = await apiClient.saveTranscript(html);
      setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Transcript saved: ${path}]` }]);
      openPath(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Transcript save failed: ${msg}]` }]);
    }
  }, [apiClient, narrativeLines, cols, campaignName, theme, stateSnapshot, activePlayerIndex, setNarrativeLines]);

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

      // Client-side commands (need access to TUI state)
      if (name === "transcript") {
        await saveTranscript();
        clearInput();
        return;
      }

      // /diagnostics: server zips campaign + .debug, client reveals it locally
      if (name === "diagnostics") {
        try {
          const { path } = await apiClient.diagnostics();
          setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Diagnostics saved: ${path}]` }]);
          revealInExplorer(path);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setNarrativeLines((prev) => [...prev, { kind: "system", text: `[Diagnostics failed: ${msg}]` }]);
        }
        clearInput();
        return;
      }

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
  }, [apiClient, activeChar, currentTurn, setNarrativeLines, clearInput, restoreInput, saveTranscript]);

  // --- Choice selection ---
  const handleChoiceSelect = useCallback(async (choice: string) => {
    setActiveChoices(null);

    // Optimistic echo. The server also rebroadcasts the contribution via
    // turn:updated so the canonical state picks it up — these lines just
    // smooth the UI while the round-trip lands.
    const tag = `optimistic-${Date.now()}`;
    setNarrativeLines((prev) => [
      ...prev,
      { kind: "separator", text: "---", tag },
      { kind: "player", text: `[${activeChar}] ${choice}`, tag },
      { kind: "dm", text: "", tag },
    ]);

    // Same path for setup and gameplay: contribute() with fromChoice=true.
    // The server's setup commit handler dispatches resolveChoice vs send
    // based on this flag.
    try {
      await apiClient.contribute(choice, {
        campaignId: currentTurn?.campaignId,
        turnSeq: currentTurn?.seq,
        fromChoice: true,
      });
    } catch {
      setNarrativeLines((prev) => prev.filter((l) => l.tag !== tag));
    }
  }, [apiClient, setActiveChoices, activeChar, currentTurn, setNarrativeLines]);

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
    } else if (item === "Save Transcript") {
      await saveTranscript();
    } else if (item === "Color Swatch") {
      setActiveModal({ kind: "swatch" } as never);
    } else if (item === "Settings") {
      try {
        const { config } = await apiClient.getSettings();
        setActiveModal({ kind: "settings", config } as never);
      } catch {
        // Fail quietly — menu will reopen on next ESC.
      }
    }
  }, [apiClient, onReturnToMenu, activeChar, setActiveModal, saveTranscript]);

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

    // Scroll keys — target character pane when open, else narrative
    if (key.pageUp || key.pageDown) {
      const step = scrollAmount(rows);
      const target = characterPaneOpen ? modalScrollRef.current : narrativeRef.current;
      target?.scrollBy(key.pageUp ? -step : step);
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

  const keyHints: KeyHint[] = useMemo(() => [
    { label: "\u21E5", active: characterPaneOpen },
  ], [characterPaneOpen]);

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
        keyHints={keyHints}
      />
      {characterPaneOpen && (
        <CharacterPane
          ref={modalScrollRef}
          theme={theme}
          characterName={activeChar}
          apiClient={apiClient}
          narrativeWidth={cols}
          narrativeHeight={narRows}
          topOffset={conversationPaneTop}
          cachedContent={characterSheetCache}
          onContentLoaded={handleCharacterSheetLoaded}
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
      {am?.kind === "recap" && (
        <SessionRecapModal
          theme={theme}
          width={cols}
          height={narRows}
          lines={(am.lines as string[]) ?? []}
          onDismiss={() => setActiveModal(null)}
          scrollRef={modalScrollRef}
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
      {am?.kind === "settings" && (
        <CampaignSettingsModal
          theme={theme}
          width={cols}
          height={narRows}
          config={am.config as CampaignConfig}
          onDismiss={() => {
            // Settings is launched from the ESC menu, so closing it (via ESC or
            // after Enter-to-save) returns to the menu rather than all the way
            // to gameplay. One more ESC then drops back to play.
            setActiveModal(null);
            setMenuOpen(true);
          }}
          onChoicesFrequencyChange={async (value: ChoiceFrequency) => {
            const cfg = am.config as CampaignConfig;
            const existingOverrides = cfg.choices?.player_overrides ?? {};
            await apiClient.patchSettings({
              choices: { campaign_default: value, player_overrides: existingOverrides },
            }).catch(() => { /* ignore — user sees no toast, value just won't persist */ });
          }}
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
