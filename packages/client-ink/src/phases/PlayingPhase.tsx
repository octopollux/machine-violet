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
import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useInput, Box, useWindowSize } from "ink";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import type { KeyHint } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, narrativeRows, choiceRowBudget } from "../tui/responsive.js";
import { useRawModeGuardian } from "../tui/hooks/useRawModeGuardian.js";
import { Layout } from "../tui/layout.js";
import { OcclusionProvider } from "../tui/image/occlusion.js";
import {
  ChoiceOverlay, DESCRIPTION_ROWS, GameMenu, ApiErrorModal,
  CharacterSheetModal, CompendiumModal, PlayerNotesModal, SwatchModal,
  SessionRecapModal, CenteredModal, CharacterPane, CampaignSettingsModal,
  RollbackSummaryModal, RollbackPickerModal, RollbackConfirmModal,
} from "../tui/modals/index.js";
import type { MenuGroup, MenuItem } from "../tui/modals/index.js";
import type { CampaignConfig, ChoiceFrequency } from "@machine-violet/shared/types/config.js";
import type { CenteredModalHandle } from "../tui/modals/index.js";
import { useGameContext } from "../tui/game-context.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import { buildTranscriptHtml, loadImageBytes } from "../commands/transcript.js";
import { openPath, revealInExplorer } from "../commands/open-path.js";
import { routePlayingPhaseKey } from "./playing-input.js";

export function PlayingPhase() {
  const {
    apiClient,
    narrativeLines, setNarrativeLines,
    theme,
    campaignName, activePlayerIndex,
    engineState, engineStateSince, toolGlyphs, resources, modelines,
    currentTurn,
    activeChoices, setActiveChoices,
    activeModal, setActiveModal,
    mode, stateSnapshot,
    usageStatus,
    sheetEpoch,
    hasKittyProtocol,
    devModeEnabled,
    showVerbose,
    retryOverlay,
    onReturnToMenu,
    reportViewport,
    dmTurnLengthPctDefault,
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
  const characterSheetCacheEpochRef = useRef<number>(0);
  // attemptId the user last dismissed the API-error modal at. The modal hides
  // while this matches the current overlay's attemptId; each fresh onRetry
  // bumps attemptId, so the next failure brings the modal back. Reset to null
  // whenever the overlay clears so a future outage that starts at the same
  // numeric attemptId still re-shows the modal.
  const [dismissedAttemptId, setDismissedAttemptId] = useState<number | null>(null);

  const clearInput = useCallback(() => { setPendingInput(""); setResetKey((k) => k + 1); }, []);
  /** Reset the input but pre-fill it with text (e.g. after a rejected contribution). */
  const restoreInput = useCallback((text: string) => { setPendingInput(text); setResetKey((k) => k + 1); }, []);

  const narrativeRef = useRef<NarrativeAreaHandle>(null);
  const modalScrollRef = useRef<CenteredModalHandle>(null);
  const escTimestamps = useRef<number[]>([]);

  // Inline images no longer need a remount-on-overlay-close hack: the
  // InlineImage renderer repaints every frame inside the sync-output block and
  // hides via the live occlusion gate (OcclusionProvider below). Modals report
  // their row-spans through CenteredModal/OverlayPane; an overlay that doesn't
  // cover the image leaves it visible.

  // Clear the dismissal latch whenever the retry overlay goes away so the
  // next outage shows the modal again — even if the new attemptId numerically
  // matches what was dismissed previously (attemptId resets to 1 after the
  // engine clears lastError on success). Keyed on the boolean rather than the
  // overlay object itself because app.tsx rebuilds the overlay on every render.
  const hasRetryOverlay = !!retryOverlay;
  useEffect(() => {
    if (!hasRetryOverlay) setDismissedAttemptId(null);
  }, [hasRetryOverlay]);

  // The modal is "active" only when there's an unresolved retry AND the user
  // hasn't dismissed this specific attempt. Each fresh retry bumps attemptId,
  // so dismissal is scoped to a single failure — the next failure shows again.
  const apiErrorModalActive =
    !!retryOverlay && retryOverlay.attemptId !== dismissedAttemptId;

  // Whether TextInput should be disabled.
  // Never block on engine state — the server rejects input if inappropriate.
  // This prevents the client from getting permanently wedged.
  // Note: gated on `retryOverlay`, not `apiErrorModalActive`. Dismissing the
  // modal unblocks the keyboard-event path (so Esc can open the pause menu),
  // but the engine is still retrying and the server has no open turn to
  // contribute to — letting the input accept text would produce a flash of
  // optimistic narrative that gets yanked out when the contribute rejects.
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

  // Layout math — used in render below and in the viewport-reporting
  // effect. Computed up here so the report still fires even when the
  // terminal is too small to render and we early-return.
  const tier = getViewportTier({ columns: cols, rows });
  const visibleElements = getVisibleElements(tier);
  const hasDescriptions = (activeChoices?.descriptions?.length ?? 0) > 0;
  const descExtraHeight = hasDescriptions ? DESCRIPTION_ROWS : 0;
  const narRows = narrativeRows(rows, visibleElements, false, theme.asset.height, players.length, descExtraHeight);

  // Report viewport dims to the server. The server tracks per-client
  // dims and reports the floor (smallest narrativeRows across clients)
  // to the DM's length hint.
  useEffect(() => {
    reportViewport({ columns: cols, rows, narrativeRows: narRows });
  }, [cols, rows, narRows, reportViewport]);

  // Clear character sheet cache when the active character changes, or when a
  // detached scribe rewrote a sheet (sheetEpoch bumped) — the latter repaints
  // an open pane with the scribe's late write instead of waiting for re-open.
  if (activeChar !== characterSheetCacheCharRef.current || sheetEpoch !== characterSheetCacheEpochRef.current) {
    characterSheetCacheCharRef.current = activeChar;
    characterSheetCacheEpochRef.current = sheetEpoch;
    setCharacterSheetCache(null);
  }
  const handleCharacterSheetLoaded = useCallback((content: string | null) => {
    setCharacterSheetCache(content);
  }, []);

  // --- Save transcript handler ---
  const saveTranscript = useCallback(async () => {
    const playerColor = stateSnapshot?.players?.[activePlayerIndex]?.color ?? "#55ff55";
    const separatorColor = themeColor(theme, "separator") ?? "#666666";
    // Pre-load image bytes referenced in the transcript so the exported
    // HTML is self-contained (single file with inline base64 data: URIs).
    // Read failures are silently skipped; the HTML renderer emits an
    // "[image unavailable]" placeholder for any missing entry.
    const imageBytes = await loadImageBytes(narrativeLines);
    const html = buildTranscriptHtml({
      narrativeLines,
      width: cols,
      campaignName,
      themeAsset: theme.asset,
      separatorColor,
      playerColor,
      quoteColor: "#ffffff",
      imageBytes,
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

  const handleNarrativeScroll = useCallback((direction: number) => {
    const step = scrollAmount(rows);
    narrativeRef.current?.scrollBy(direction < 0 ? -step : step);
  }, [rows]);

  // --- Menu ---
  // Action helpers — extracted so menu items can colocate their behavior.
  const openCharacterSheet = useCallback(async () => {
    try {
      const { content } = await apiClient.getCharacterSheet(activeChar);
      setActiveModal({ kind: "character_sheet", content } as never);
    } catch { setActiveModal({ kind: "character_sheet", content: "(No character sheet found)" } as never); }
  }, [apiClient, activeChar, setActiveModal]);

  const openCompendium = useCallback(async () => {
    try {
      const { data } = await apiClient.getCompendium();
      setActiveModal({ kind: "compendium", data } as never);
    } catch { /* ignore */ }
  }, [apiClient, setActiveModal]);

  const openPlayerNotes = useCallback(async () => {
    try {
      const { content } = await apiClient.getNotes();
      setActiveModal({ kind: "notes", content } as never);
    } catch { setActiveModal({ kind: "notes", content: "" } as never); }
  }, [apiClient, setActiveModal]);

  const openCampaignSettings = useCallback(async () => {
    try {
      const { config } = await apiClient.getSettings();
      setActiveModal({ kind: "settings", config } as never);
    } catch { /* fail quietly — menu reopens on next ESC */ }
  }, [apiClient, setActiveModal]);

  const openRollbackPicker = useCallback(async () => {
    try {
      const { savepoints, gitEnabled } = await apiClient.getSavepoints();
      setActiveModal({ kind: "rollback_picker", savepoints, gitEnabled } as never);
    } catch {
      // Surface an empty/disabled picker rather than silently swallowing.
      setActiveModal({ kind: "rollback_picker", savepoints: [], gitEnabled: false } as never);
    }
  }, [apiClient, setActiveModal]);

  const toggleEngineConsole = useCallback(() => {
    // Silent catch matches the triple-ESC and direct-ESC mode-toggle handlers
    // elsewhere in this component — a transient command failure shouldn't
    // surface as an unhandled rejection, and the user can retry from the menu.
    apiClient.command(mode === "dev" ? "exit_mode" : "dev").catch(() => { /* no-op */ });
  }, [apiClient, mode]);

  // Build grouped menu items. View-on-top so the cursor doesn't sit on a
  // leave action when the user opens the menu to do something. Engine
  // Console is gated on dev mode (master toggle in Settings).
  const menuGroups = useMemo(() => {
    const groups: MenuGroup[] = [
      {
        title: "View",
        items: [
          { key: "character_sheet", label: "Character Sheet", action: () => void openCharacterSheet() },
          { key: "compendium", label: "Compendium", action: () => void openCompendium() },
          { key: "player_notes", label: "Player Notes", action: () => void openPlayerNotes() },
        ],
      },
    ];

    const sessionItems: MenuItem[] = [];
    if (devModeEnabled) {
      sessionItems.push({
        key: "engine_console",
        label: mode === "dev" ? "Exit Engine Console" : "Engine Console",
        action: toggleEngineConsole,
      });
    }
    sessionItems.push({ key: "save_transcript", label: "Save Transcript", action: () => void saveTranscript() });
    groups.push({ title: "Session", items: sessionItems });

    groups.push({
      title: "Settings",
      items: [{ key: "campaign_settings", label: "Campaign Settings", action: () => void openCampaignSettings() }],
    });

    groups.push({
      title: "Exit",
      items: [
        { key: "resume", label: "Resume", action: () => { /* dismiss-only */ } },
        { key: "return_to_menu", label: "Return to Menu", action: onReturnToMenu },
      ],
    });

    return groups;
  }, [devModeEnabled, mode, openCharacterSheet, openCompendium, openPlayerNotes, openCampaignSettings, toggleEngineConsole, saveTranscript, onReturnToMenu]);

  // --- Input handling ---
  useInput((_input, key) => {
    // Triple-Esc panic-reset bookkeeping is stateful (a timestamp ring), so it
    // stays here; the routing *decision* below is pure (see playing-input.ts).
    let tripleEscReady = false;
    if (key.escape) {
      const now = Date.now();
      escTimestamps.current.push(now);
      escTimestamps.current = escTimestamps.current.filter((t) => now - t <= 1500);
      tripleEscReady = escTimestamps.current.length >= 3;
    }

    // Esc/menu both open the pause menu and refresh the token summary.
    const openMenu = () => {
      setMenuOpen(true);
      apiClient.getCost().then(({ formatted }) => setTokenSummary(formatted)).catch(() => { /* no-op */ });
    };

    const action = routePlayingPhaseKey(
      { escape: !!key.escape, tab: !!key.tab, pageUp: !!key.pageUp, pageDown: !!key.pageDown },
      {
        tripleEscReady,
        apiErrorModalActive,
        hasRetryOverlay: !!retryOverlay,
        activeModal: !!activeModal,
        menuOpen,
        activeChoices: !!activeChoices,
        characterPaneOpen,
        mode,
      },
    );

    switch (action) {
      case "tripleEscReset":
        escTimestamps.current = [];
        setActiveChoices(null);
        setActiveModal(null);
        setMenuOpen(false);
        setCharacterPaneOpen(false);
        if (mode === "ooc" || mode === "dev") {
          apiClient.command("exit_mode").catch(() => { /* no-op */ });
        }
        return;
      case "dismissApiError":
        // Latched on attemptId so the next retry brings the modal back.
        if (retryOverlay) setDismissedAttemptId(retryOverlay.attemptId);
        return;
      // The choice overlay's own input is disabled while the menu is open
      // (isActive prop), so arrow keys/Enter don't drive both UIs at once.
      case "openMenuOverChoices":
      case "openMenu":
        openMenu();
        return;
      case "toggleCharacterPane":
        setCharacterPaneOpen((prev) => !prev);
        return;
      case "exitMode":
        apiClient.command("exit_mode").catch(() => { /* no-op */ });
        return;
      case "dismissCharacterPane":
        setCharacterPaneOpen(false);
        return;
      case "scroll": {
        // Target the character pane when open, else the narrative.
        const step = scrollAmount(rows);
        const target = characterPaneOpen ? modalScrollRef.current : narrativeRef.current;
        target?.scrollBy(key.pageUp ? -step : step);
        return;
      }
      case "blocked":
      case "choicesBlocked":
      case "none":
        return;
    }
  });

  const keyHints: KeyHint[] = useMemo(() => [
    { label: "\u21E5", active: characterPaneOpen },
  ], [characterPaneOpen]);

  // --- Render ---
  // NB: keep every hook above this early return. Shrinking the terminal flips
  // `tooSmall`, and any hook rendered only on the non-tiny path would change the
  // hook count between renders ("Rendered fewer hooks than expected").
  if (tooSmall) {
    return <TerminalTooSmall columns={cols} rows={rows} />;
  }

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
      onSelect={handleChoiceSelect}
      onNarrativeScroll={handleNarrativeScroll}
      isActive={!menuOpen && !activeModal && !apiErrorModalActive}
    />
  ) : undefined;

  return (
    <OcclusionProvider>
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
        engineStateSince={engineStateSince}
        toolGlyphs={toolGlyphs}
        quoteColor="#ffffff"
        playerColor={stateSnapshot?.players?.[activePlayerIndex]?.color}
        playerFrameColor={engineState === "waiting_input" ? stateSnapshot?.players?.[activePlayerIndex]?.color : "#808080"}
        showVerbose={showVerbose}
        narrativeRef={narrativeRef}
        conversationPaneTop={conversationPaneTop}
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
      {apiErrorModalActive && retryOverlay && (
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
      {am?.kind === "rollback" && (
        <RollbackSummaryModal
          theme={theme}
          width={cols}
          height={narRows}
          summary={String(am.summary ?? "")}
          onDismiss={onReturnToMenu}
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
          onDmTurnLengthPctChange={async (value: number) => {
            await apiClient.patchSettings({
              dm_turn_length_pct: value,
            }).catch(() => { /* ignore — same rationale as Choices Frequency above */ });
          }}
          onImageGenerationChange={async (value: "on" | "off") => {
            await apiClient.patchSettings({
              image_generation: value,
            }).catch(() => { /* ignore — same rationale as Choices Frequency above */ });
          }}
          globalDmTurnLengthPctDefault={dmTurnLengthPctDefault}
          onOpenRollback={() => void openRollbackPicker()}
        />
      )}
      {am?.kind === "rollback_picker" && (
        <RollbackPickerModal
          theme={theme}
          width={cols}
          height={narRows}
          savepoints={(am.savepoints as never) ?? []}
          gitEnabled={am.gitEnabled !== false}
          onSelect={(savepoint, index) =>
            setActiveModal({ kind: "rollback_confirm", savepoint, discardCount: index } as never)}
          onCancel={() => void openCampaignSettings()}
          topOffset={conversationPaneTop}
        />
      )}
      {am?.kind === "rollback_confirm" && (
        <RollbackConfirmModal
          theme={theme}
          width={cols}
          height={narRows}
          savepoint={am.savepoint as never}
          discardCount={Number(am.discardCount ?? 0)}
          onConfirm={() => {
            // Fire the rollback; don't set a modal — the server ends the session
            // and the stashed rollbackSummary drives RollbackSummaryModal via the
            // app.tsx sessionEnded effect, then Enter returns to the menu.
            const oid = (am.savepoint as { oid: string }).oid;
            apiClient.command("rollback", oid).catch(() => { /* no-op; surfaced as system msg */ });
          }}
          onCancel={() => void openRollbackPicker()}
          topOffset={conversationPaneTop}
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
          groups={menuGroups}
          tokenSummary={tokenSummary}
          usageStatus={usageStatus}
          onDismiss={() => setMenuOpen(false)}
        />
      )}
    </Box>
    </OcclusionProvider>
  );
}
