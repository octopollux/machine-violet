/**
 * Client-ink App — connects to the engine server and renders the TUI.
 *
 * This is the top-level component for the Ink TUI client. Unlike the
 * monolith's App which managed engine lifecycle, this app is purely
 * a rendering client that:
 *
 * 1. Connects to the engine server (REST + WebSocket)
 * 2. Receives state and events via WebSocket
 * 3. Renders the PlayingPhase with server-driven state
 * 4. Sends player input via REST
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";
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
import {
  loadThemeDefinition,
  resolveTheme,
} from "./tui/themes/index.js";
import type { ResolvedTheme, StyleVariant, ThemeDefinition } from "./tui/themes/index.js";

export interface AppProps {
  /** Engine server base URL (e.g. "http://127.0.0.1:7200") */
  serverUrl: string;
  /** Player identity */
  playerId: string;
  /** Campaign to start/resume (if provided, skips campaign selection) */
  campaignId?: string;
}

type AppPhase = "connecting" | "selecting" | "starting" | "playing" | "disconnected" | "error";

export function App({ serverUrl, playerId, campaignId }: AppProps) {
  const [phase, setPhase] = useState<AppPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [clientState, setClientState] = useState<ClientState>(initialClientState);

  // Theme state
  const [themeDef] = useState<ThemeDefinition>(() => loadThemeDefinition("clean"));
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const [keyColor, setKeyColor] = useState("#8888aa");
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(loadThemeDefinition("clean"), "exploration"));

  // Narrative lines (managed here, passed to context)
  const [narrativeLines, setNarrativeLines] = useState<NarrativeLine[]>([]);

  // Modal state
  const [activeModal, setActiveModal] = useState<Modal | null>(null);

  // Connection refs (stable across renders)
  const apiClientRef = useRef<ApiClient>(new ApiClient(serverUrl, playerId));
  const wsClientRef = useRef<WsClient | null>(null);

  // Sync theme when variant/keyColor changes
  useEffect(() => {
    setTheme(resolveTheme(themeDef, variant, keyColor));
  }, [themeDef, variant, keyColor]);

  // Sync event handler state into our React state
  const handleStateUpdate = useCallback((fn: (prev: ClientState) => ClientState) => {
    setClientState((prev) => {
      const next = fn(prev);
      // Sync narrative lines from event handler
      if (next.narrativeLines !== prev.narrativeLines) {
        setNarrativeLines(next.narrativeLines);
      }
      // Sync modal from event handler
      if (next.activeModal !== prev.activeModal) {
        setActiveModal(next.activeModal);
      }
      // Sync variant from event handler
      if (next.variant !== prev.variant) {
        setVariant(next.variant);
      }
      return next;
    });
  }, []);

  // Connect to server on mount
  useEffect(() => {
    const eventHandler = createEventHandler(handleStateUpdate);

    const ws = new WsClient({
      url: `${serverUrl.replace(/^http/, "ws")}/session/ws?role=player&player=${encodeURIComponent(playerId)}`,
      onEvent: eventHandler,
      onConnect: () => {
        if (campaignId) {
          // Auto-start campaign
          setPhase("starting");
          apiClientRef.current.startCampaign(campaignId).then(() => {
            setPhase("playing");
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
            setPhase("error");
          });
        } else {
          setPhase("selecting");
        }
      },
      onDisconnect: () => {
        if (phase !== "error") {
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

    return () => {
      ws.disconnect();
    };
  }, []); // Run once on mount — serverUrl/playerId/campaignId are stable props

  // --- Render by phase ---

  if (phase === "connecting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Connecting to {serverUrl}...</Text>
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

  if (phase === "selecting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Connected. No campaign specified — pass --campaign to auto-start.</Text>
        <Text dimColor>Press Ctrl+C to exit.</Text>
      </Box>
    );
  }

  if (phase === "starting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Starting campaign: {campaignId}...</Text>
      </Box>
    );
  }

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
      campaignName: stateSnapshot?.campaignName ?? campaignId ?? "",
      activePlayerIndex: stateSnapshot?.activePlayerIndex ?? 0,
      setActivePlayerIndex: () => { /* server manages this */ },
      engineState: clientState.engineState,
      toolGlyphs: clientState.activeTools.map((t) => ({ name: t, glyph: "⚙", label: t })),
      resources: [],
      modelines: stateSnapshot?.modelines ?? {},
      currentTurn: clientState.currentTurn,
      activeModal,
      setActiveModal: (m) => setActiveModal(m as Modal | null),
      retryOverlay: clientState.lastError?.recoverable
        ? { status: 0, delaySec: 5 }
        : null,
      mode: clientState.mode,
      stateSnapshot,
      onReturnToMenu: () => {
        apiClient.endSession().catch(() => { /* no-op */ });
        process.exit(0);
      },
    }}>
      <PlayingPhase />
    </GameProvider>
  );
}
