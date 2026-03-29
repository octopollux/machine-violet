/**
 * Client-ink App — connects to the engine server and renders the TUI.
 *
 * Phases:
 *   connecting → menu (campaign list) → starting → playing
 *   If --campaign is provided, skips menu and goes straight to starting.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { useBatchedNarrativeLines } from "./tui/hooks/useBatchedNarrativeLines.js";
import type { Modal } from "@machine-violet/shared";
import { ApiClient } from "./api-client.js";
import { WsClient } from "./ws-client.js";
import {
  createEventHandler,
  initialClientState,
  type ClientState,
} from "./event-handler.js";
import { GameProvider } from "./tui/game-context.js";
import { PlayingPhase } from "./phases/PlayingPhase.js";
import { MainMenuPhase } from "./phases/MainMenuPhase.js";
import type { CampaignEntry } from "./phases/MainMenuPhase.js";
import {
  loadThemeDefinition,
  resolveTheme,
} from "./tui/themes/index.js";
import type { ResolvedTheme, StyleVariant, ThemeDefinition } from "./tui/themes/index.js";

/** Format display resources into "Key Value" strings for the top frame. */
function formatResources(
  displayResources: Record<string, string[]>,
  resourceValues: Record<string, Record<string, string>>,
): string[] {
  const result: string[] = [];
  for (const [char, keys] of Object.entries(displayResources)) {
    const vals = resourceValues[char] ?? {};
    for (const key of keys) {
      const val = vals[key];
      result.push(val ? `${key} ${val}` : key);
    }
  }
  return result;
}

export interface AppProps {
  serverUrl: string;
  playerId: string;
  campaignId?: string;
}

type AppPhase = "connecting" | "menu" | "starting" | "playing" | "disconnected" | "error";

// --- Main App ---

export function App({ serverUrl, playerId, campaignId }: AppProps) {
  const [phase, setPhase] = useState<AppPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [clientState, setClientState] = useState<ClientState>(initialClientState);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState(campaignId ?? "");
  // Session counter forces full PlayingPhase remount on campaign switch
  const [sessionKey, setSessionKey] = useState(0);

  // Theme state
  const [themeDef, setThemeDef] = useState<ThemeDefinition>(() => loadThemeDefinition("gothic"));
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const [keyColor, setKeyColor] = useState("#8888aa");
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(loadThemeDefinition("gothic"), "exploration"));

  // Batching hook ensures spacer lines survive React reconciliation for paragraph spacing
  const { lines: narrativeLines, setLines: setNarrativeLines } = useBatchedNarrativeLines();
  const [activeModal, setActiveModal] = useState<Modal | null>(null);

  const apiClientRef = useRef<ApiClient>(new ApiClient(serverUrl, playerId));
  const wsClientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    setTheme(resolveTheme(themeDef, variant, keyColor));
  }, [themeDef, variant, keyColor]);

  const handleStateUpdate = useCallback((fn: (prev: ClientState) => ClientState) => {
    setClientState((prev) => {
      const next = fn(prev);
      if (next.narrativeLines !== prev.narrativeLines) setNarrativeLines(next.narrativeLines);
      if (next.activeModal !== prev.activeModal) setActiveModal(next.activeModal);
      if (next.variant !== prev.variant) setVariant(next.variant);
      // Hydrate theme from state snapshot (persisted UI state from server)
      if (next.stateSnapshot !== prev.stateSnapshot && next.stateSnapshot) {
        const snap = next.stateSnapshot;
        if (snap.keyColor) setKeyColor(snap.keyColor);
        if (snap.variant) setVariant(snap.variant as StyleVariant);
        // Load the campaign's theme definition (frame assets, gradient config)
        if (snap.themeName) {
          try {
            const def = loadThemeDefinition(snap.themeName);
            setThemeDef(def);
          } catch { /* fall back to current theme */ }
        }
      }
      return next;
    });
  }, []);

  // Start a campaign (used by both auto-start and menu selection)
  const startCampaign = useCallback((id: string) => {
    setActiveCampaignId(id);
    setSessionKey((k) => k + 1);
    setPhase("starting");
    setNarrativeLines([]);
    setClientState(initialClientState());

    apiClientRef.current.startCampaign(id).then(() => {
      setPhase("playing");
    }).catch((err) => {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    });
  }, []);

  // Return to menu from playing
  const returnToMenu = useCallback(async () => {
    // Await endSession so the server fully tears down before we can start another
    try { await apiClientRef.current.endSession(); } catch { /* no-op */ }
    // Full state reset
    setNarrativeLines([]);
    setActiveModal(null);
    setClientState(initialClientState());
    setVariant("exploration");
    setKeyColor("#8888aa");
    setThemeDef(loadThemeDefinition("gothic"));
    setPhase("menu");
    // Refresh campaign list
    apiClientRef.current.listCampaigns().then((resp) => {
      setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name, path: c.path ?? "" })));
    }).catch(() => { /* ignore */ });
  }, []);

  // Connect to server on mount
  useEffect(() => {
    const eventHandler = createEventHandler(handleStateUpdate);
    const api = apiClientRef.current;

    const ws = new WsClient({
      url: `${serverUrl.replace(/^http/, "ws")}/session/ws?role=player&player=${encodeURIComponent(playerId)}`,
      onEvent: eventHandler,
      onConnect: () => {
        if (campaignId) {
          startCampaign(campaignId);
        } else {
          // Fetch campaigns and show menu
          api.listCampaigns().then((resp) => {
            setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name, path: c.path ?? "" })));
            setPhase("menu");
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
            setPhase("error");
          });
        }
      },
      onDisconnect: () => {
        if (phase !== "error" && phase !== "menu") {
          setPhase("disconnected");
        }
      },
      onError: (err) => {
        setErrorMessage(err.message);
        setPhase("error");
      },
    });

    wsClientRef.current = ws;
    ws.connect();

    return () => ws.disconnect();
  }, []); // eslint-disable-line

  // --- Render by phase ---

  if (phase === "connecting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>Connecting to engine server...</Text>
      </Box>
    );
  }

  if (phase === "disconnected") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Disconnected from server. Reconnecting...</Text>
      </Box>
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {errorMessage}</Text>
        <Text dimColor>Press Ctrl+C to exit.</Text>
      </Box>
    );
  }

  if (phase === "menu") {
    return (
      <MainMenuPhase
        theme={theme}
        campaigns={campaigns}
        errorMsg={errorMessage || null}
        apiKeyValid={true}
        onNewCampaign={() => {
          setSessionKey((k) => k + 1);
          setPhase("starting");
          setErrorMessage("");
          apiClientRef.current.createCampaign().then(() => {
            setPhase("playing");
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
            setPhase("menu");
          });
        }}
        onResumeCampaign={(entry) => startCampaign(entry.id ?? entry.name)}
        onArchiveCampaign={() => { /* TODO */ }}
        onDeleteCampaign={() => { /* TODO */ }}
        deleteModal={null}
        onConfirmDelete={() => { /* no-op */ }}
        onCancelDelete={() => { /* no-op */ }}
        onAddContent={() => { /* TODO */ }}
        onSettings={() => { /* TODO */ }}
        onSettingsApiKeys={() => { /* TODO */ }}
        onQuit={() => process.exit(0)}
      />
    );
  }

  // "starting" falls through to playing phase — PlayingPhase renders fine
  // with empty narrative (themed frame, empty conversation area). No need
  // for a separate loading screen that causes a visual flash.

  if (phase !== "playing" && phase !== "starting") return null;

  // --- Playing phase ---

  const stateSnapshot = clientState.stateSnapshot;
  const apiClient = apiClientRef.current;

  return (
    <GameProvider value={{
      apiClient,
      connected: wsClientRef.current?.connected ?? false,
      narrativeLines,
      setNarrativeLines,
      theme,
      variant,
      setVariant,
      setTheme,
      keyColor,
      setKeyColor,
      campaignName: stateSnapshot?.campaignName ?? activeCampaignId,
      activePlayerIndex: stateSnapshot?.activePlayerIndex ?? 0,
      setActivePlayerIndex: () => { /* server manages this */ },
      engineState: clientState.engineState,
      toolGlyphs: clientState.activeTools.map((t) => ({ name: t, glyph: "⚙", label: t })),
      resources: Object.keys(clientState.displayResources).length > 0
        ? formatResources(clientState.displayResources, clientState.resourceValues)
        : [],
      modelines: {
        ...stateSnapshot?.modelines,
        ...clientState.modelines,
      },
      currentTurn: clientState.currentTurn,
      activeModal,
      setActiveModal: (m) => setActiveModal(m as Modal | null),
      retryOverlay: clientState.lastError?.recoverable
        ? { status: 0, delaySec: 5 }
        : null,
      mode: clientState.mode,
      stateSnapshot,
      onReturnToMenu: returnToMenu,
    }}>
      <PlayingPhase key={`${activeCampaignId}-${sessionKey}`} />
    </GameProvider>
  );
}
