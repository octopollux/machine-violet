/**
 * Client-ink App — connects to the engine server and renders the TUI.
 *
 * Phases:
 *   connecting → menu (campaign list) → starting → playing
 *   If --campaign is provided, skips menu and goes straight to starting.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
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
  serverUrl: string;
  playerId: string;
  campaignId?: string;
}

type AppPhase = "connecting" | "menu" | "starting" | "playing" | "disconnected" | "error";

interface CampaignItem {
  id: string;
  name: string;
}

// --- Campaign Menu Component ---

function CampaignMenu({ campaigns, onSelect, onQuit }: {
  campaigns: CampaignItem[];
  onSelect: (id: string) => void;
  onQuit: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemCount = campaigns.length + 1; // campaigns + Quit

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + itemCount) % itemCount);
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % itemCount);
    } else if (key.return) {
      if (selectedIndex < campaigns.length) {
        onSelect(campaigns[selectedIndex].id);
      } else {
        onQuit();
      }
    } else if (_input === "q" || _input === "Q") {
      onQuit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Machine Violet</Text>
      </Box>

      {campaigns.length > 0 ? (
        <>
          <Box marginBottom={1}>
            <Text dimColor>Select a campaign to resume:</Text>
          </Box>
          {campaigns.map((c, i) => (
            <Box key={c.id}>
              <Text
                color={i === selectedIndex ? "cyan" : undefined}
                bold={i === selectedIndex}
              >
                {i === selectedIndex ? " ▸ " : "   "}
                {c.name}
              </Text>
            </Box>
          ))}
        </>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>No campaigns found. Create one with the monolith first (npm run dev:monolith).</Text>
        </Box>
      )}

      <Box marginTop={campaigns.length > 0 ? 1 : 0}>
        <Text
          color={selectedIndex === campaigns.length ? "red" : "gray"}
          bold={selectedIndex === campaigns.length}
        >
          {selectedIndex === campaigns.length ? " ▸ " : "   "}
          Quit
        </Text>
      </Box>
    </Box>
  );
}

// --- Main App ---

export function App({ serverUrl, playerId, campaignId }: AppProps) {
  const [phase, setPhase] = useState<AppPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [clientState, setClientState] = useState<ClientState>(initialClientState);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState(campaignId ?? "");

  // Theme state
  const [themeDef] = useState<ThemeDefinition>(() => loadThemeDefinition("clean"));
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const [keyColor, setKeyColor] = useState("#8888aa");
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(loadThemeDefinition("clean"), "exploration"));

  const [narrativeLines, setNarrativeLines] = useState<NarrativeLine[]>([]);
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
      return next;
    });
  }, []);

  // Start a campaign (used by both auto-start and menu selection)
  const startCampaign = useCallback((id: string) => {
    setActiveCampaignId(id);
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
  const returnToMenu = useCallback(() => {
    apiClientRef.current.endSession().catch(() => { /* no-op */ });
    setPhase("menu");
    setNarrativeLines([]);
    setClientState(initialClientState());
    // Refresh campaign list
    apiClientRef.current.listCampaigns().then((resp) => {
      setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name })));
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
            setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name })));
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
      <CampaignMenu
        campaigns={campaigns}
        onSelect={startCampaign}
        onQuit={() => process.exit(0)}
      />
    );
  }

  if (phase === "starting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading campaign...</Text>
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
      campaignName: stateSnapshot?.campaignName ?? activeCampaignId,
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
      onReturnToMenu: returnToMenu,
    }}>
      <PlayingPhase />
    </GameProvider>
  );
}
