/**
 * Client-ink App — connects to the engine server and renders the TUI.
 *
 * Phases:
 *   connecting → menu (campaign list) → starting → playing
 *   If --campaign is provided, skips menu and goes straight to starting.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { useBatchedNarrativeLines } from "./tui/hooks/useBatchedNarrativeLines.js";
import type { ChoicesData } from "@machine-violet/shared";
import type { ActiveModal } from "@machine-violet/shared/types/tui.js";
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
import { SettingsPhase } from "./phases/SettingsPhase.js";
import { ConnectionsPhase } from "./phases/ConnectionsPhase.js";
import { ArchivedCampaignsPhase } from "./phases/ArchivedCampaignsPhase.js";
import { DiscordSettingsPhase } from "./phases/DiscordSettingsPhase.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, ConnectionHealthResponse,
  KnownModelInfo,
} from "./api-client.js";
import type { ArchivedCampaignEntry, CampaignDeleteInfo } from "./config/campaign-archive.js";
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

type AppPhase =
  | "connecting" | "menu" | "starting" | "playing" | "disconnected" | "error"
  | "settings" | "settings_apikeys" | "api_keys" | "archived_campaigns" | "discord_settings";

/** Error screen with keyboard input — press Enter to return to menu or q to quit. */
function ErrorScreen({ message, onReturnToMenu }: { message: string; onReturnToMenu: () => void }) {
  useInput((input, key) => {
    if (key.return || key.escape) {
      onReturnToMenu();
    } else if (input === "q") {
      process.exit(0);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">Error: {message}</Text>
      <Text dimColor>Press Enter to return to menu, or q to quit.</Text>
    </Box>
  );
}

// --- Main App ---

export function App({ serverUrl, playerId, campaignId }: AppProps) {
  const [phase, setPhase] = useState<AppPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [clientState, setClientState] = useState<ClientState>(initialClientState);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState(campaignId ?? "");
  // Session counter forces full PlayingPhase remount on campaign switch
  const [sessionKey, setSessionKey] = useState(0);

  // Settings / management state
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [tierAssignments, setTierAssignments] = useState<TierAssignmentsResponse>({ large: null, medium: null, small: null });
  const [connHealthResults, setConnHealthResults] = useState<Record<string, ConnectionHealthResponse>>({});
  const [knownModels, setKnownModels] = useState<Record<string, KnownModelInfo>>({});
  const [apiKeyValid, setApiKeyValid] = useState(true);
  const [apiKeyStatus, setApiKeyStatus] = useState<string | undefined>(undefined);
  const [archivedCampaigns, setArchivedCampaigns] = useState<ArchivedCampaignEntry[]>([]);
  const [discordEnabled, setDiscordEnabled] = useState<boolean | null>(null);
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [showVerbose, setShowVerbose] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState("");
  const [deleteModal, setDeleteModal] = useState<CampaignDeleteInfo | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Theme state
  const [themeDef, setThemeDef] = useState<ThemeDefinition>(() => loadThemeDefinition("gothic"));
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const [keyColor, setKeyColor] = useState("#8888aa");
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(loadThemeDefinition("gothic"), "exploration"));

  // Batching hook ensures spacer lines survive React reconciliation for paragraph spacing
  const { lines: narrativeLines, setLines: setNarrativeLines } = useBatchedNarrativeLines();
  const [activeChoices, setActiveChoices] = useState<ChoicesData | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);

  const apiClientRef = useRef<ApiClient>(new ApiClient(serverUrl, playerId));
  const wsClientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    setTheme(resolveTheme(themeDef, variant, keyColor));
  }, [themeDef, variant, keyColor]);

  const handleStateUpdate = useCallback((fn: (prev: ClientState) => ClientState) => {
    setClientState((prev) => {
      const next = fn(prev);
      if (next.narrativeLines !== prev.narrativeLines) setNarrativeLines(next.narrativeLines);
      if (next.activeChoices !== prev.activeChoices) setActiveChoices(next.activeChoices);
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

  // Detect stale session (idle timeout, campaign mismatch) and return to menu
  useEffect(() => {
    if (phase !== "playing" && phase !== "starting") return;
    if (clientState.sessionStale) {
      setErrorMessage("This session was saved and exited.");
      returnToMenu();
    } else if (clientState.sessionEnded) {
      returnToMenu();
    }
  }, [clientState.sessionStale, clientState.sessionEnded, phase]);

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

  /** Check connection health + Discord setting for main menu indicators. */
  const refreshMenuStatus = useCallback(() => {
    const api = apiClientRef.current;
    api.listConnections().then((resp) => {
      setConnections(resp.connections);
      setTierAssignments(resp.tierAssignments);
      if (resp.connections.length > 0) {
        setApiKeyValid(true);
        // Check health of first connection
        api.checkConnection(resp.connections[0].id).then((h) => {
          setApiKeyValid(h.status === "valid" || h.status === "rate_limited");
          setApiKeyStatus(h.message);
        }).catch(() => { /* ignore */ });
      } else {
        setApiKeyValid(false);
        setApiKeyStatus("No AI connections configured");
      }
    }).catch(() => { /* ignore */ });
    api.getDiscordSettings().then((s) => setDiscordEnabled(s.enabled)).catch(() => { /* ignore */ });
  }, []);

  // Return to menu from playing
  const returnToMenu = useCallback(async () => {
    // Show a saving overlay on top of PlayingPhase while the server tears down
    setActiveModal({ kind: "saving" });
    // End the session and poll until the server confirms it is fully idle.
    // This prevents the race where a quick exit+re-enter outruns the backend.
    try { await apiClientRef.current.endSession(); } catch { /* no-op */ }
    try { await apiClientRef.current.waitForIdle(); } catch { /* timeout is best-effort */ }
    // Full state reset
    setNarrativeLines([]);
    setActiveChoices(null);
    setActiveModal(null);
    setClientState(initialClientState());
    setVariant("exploration");
    setKeyColor("#8888aa");
    setThemeDef(loadThemeDefinition("gothic"));
    setPhase("menu");
    // Refresh campaign list and menu status indicators
    apiClientRef.current.listCampaigns().then((resp) => {
      setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name, path: c.path ?? "" })));
    }).catch(() => { /* ignore */ });
    refreshMenuStatus();
  }, [refreshMenuStatus]);

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
            refreshMenuStatus();
            setPhase("menu");
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
            setPhase("error");
          });
        }
      },
      onDisconnect: () => {
        setPhase((prev) => (prev === "error" || prev === "menu" ? prev : "disconnected"));
      },
      onError: (err) => {
        setErrorMessage(err.message);
        setPhase("error");
      },
    });

    wsClientRef.current = ws;
    ws.connect();

    return () => ws.disconnect();
  }, []);

  // --- Management helpers ---

  const refreshConnections = useCallback(() => {
    const api = apiClientRef.current;
    api.listConnections().then((resp) => {
      setConnections(resp.connections);
      setTierAssignments(resp.tierAssignments);
    }).catch(() => { /* ignore */ });
    api.listKnownModels().then((resp) => {
      setKnownModels(resp.models);
    }).catch(() => { /* ignore */ });
  }, []);

  const handleCheckConnection = useCallback((connId: string) => {
    setConnHealthResults((prev) => ({ ...prev, [connId]: { id: connId, status: "valid", message: "Checking..." } }));
    apiClientRef.current.checkConnection(connId).then((resp) => {
      setConnHealthResults((prev) => ({ ...prev, [connId]: resp }));
    }).catch(() => {
      setConnHealthResults((prev) => ({
        ...prev,
        [connId]: { id: connId, status: "error", message: "Health check failed" },
      }));
    });
  }, []);

  const refreshCampaigns = useCallback(() => {
    apiClientRef.current.listCampaigns().then((resp) => {
      setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name, path: c.path ?? "" })));
    }).catch(() => { /* ignore */ });
  }, []);

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
      <ErrorScreen
        message={errorMessage}
        onReturnToMenu={() => {
          setErrorMessage("");
          setPhase("menu");
          refreshMenuStatus();
          apiClientRef.current.listCampaigns().then((resp) => {
            setCampaigns(resp.campaigns.map((c) => ({ id: c.id ?? c.name, name: c.name, path: c.path ?? "" })));
          }).catch(() => { /* ignore */ });
        }}
      />
    );
  }

  if (phase === "menu") {
    return (
      <MainMenuPhase
        theme={theme}
        campaigns={campaigns}
        errorMsg={errorMessage || null}
        apiKeyValid={apiKeyValid}
        apiKeyStatus={apiKeyStatus}
        discordSettingUnset={discordEnabled === null}
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
        onArchiveCampaign={(entry) => {
          const id = entry.id ?? entry.name;
          apiClientRef.current.archiveCampaign(id).then(() => {
            refreshCampaigns();
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
          });
        }}
        onDeleteCampaign={(entry) => {
          const id = entry.id ?? entry.name;
          setPendingDeleteId(id);
          apiClientRef.current.getCampaignDeleteInfo(id).then((info) => {
            setDeleteModal(info);
          }).catch(() => {
            setDeleteModal({ campaignName: entry.name, characterNames: [], dmTurnCount: 0 });
          });
        }}
        deleteModal={deleteModal}
        onConfirmDelete={() => {
          if (pendingDeleteId) {
            apiClientRef.current.deleteCampaign(pendingDeleteId).then(() => {
              refreshCampaigns();
            }).catch((err) => {
              setErrorMessage(err instanceof Error ? err.message : String(err));
            });
          }
          setDeleteModal(null);
          setPendingDeleteId(null);
        }}
        onCancelDelete={() => { setDeleteModal(null); setPendingDeleteId(null); }}
        onAddContent={() => { /* not yet migrated */ }}
        onSettings={() => setPhase("settings")}
        onSettingsApiKeys={() => { refreshConnections(); setPhase("settings_apikeys"); }}
        onDiscordSettings={() => {
          apiClientRef.current.getDiscordSettings().then((s) => setDiscordEnabled(s.enabled)).catch(() => { /* ignore */ });
          setPhase("discord_settings");
        }}
        onQuit={() => process.exit(0)}
      />
    );
  }

  if (phase === "settings" || phase === "settings_apikeys") {
    return (
      <SettingsPhase
        theme={theme}
        initialView={phase === "settings_apikeys" ? "api_keys" : undefined}
        devModeEnabled={devModeEnabled}
        onToggleDevMode={() => setDevModeEnabled((v) => !v)}
        showVerbose={showVerbose}
        onToggleVerbose={() => setShowVerbose((v) => !v)}
        onApiKeys={() => { refreshConnections(); setPhase("api_keys"); }}
        onDiscord={() => {
          apiClientRef.current.getDiscordSettings().then((s) => setDiscordEnabled(s.enabled)).catch(() => { /* ignore */ });
          setPhase("discord_settings");
        }}
        onArchivedCampaigns={() => {
          apiClientRef.current.listArchivedCampaigns().then((resp) => setArchivedCampaigns(resp.archives)).catch(() => { /* ignore */ });
          setPhase("archived_campaigns");
        }}
        onBack={() => setPhase("menu")}
      />
    );
  }

  if (phase === "api_keys") {
    return (
      <ConnectionsPhase
        theme={theme}
        connections={connections}
        tierAssignments={tierAssignments}
        healthResults={connHealthResults}
        knownModels={knownModels}
        onAddConnection={(provider, apiKey, label, baseUrl) => {
          apiClientRef.current.addConnection(provider, apiKey, label, baseUrl).then((resp) => {
            setConnections(resp.connections);
            setTierAssignments(resp.tierAssignments);
          }).catch(() => { /* ignore */ });
        }}
        onRemoveConnection={(id) => {
          apiClientRef.current.removeConnection(id).then((resp) => {
            setConnections(resp.connections);
            setTierAssignments(resp.tierAssignments);
          }).catch(() => { /* ignore */ });
        }}
        onCheckHealth={handleCheckConnection}
        onSetTier={(tier, assignment) => {
          apiClientRef.current.setTierAssignments({ [tier]: assignment }).then((resp) => {
            setTierAssignments(resp.tierAssignments);
          }).catch(() => { /* ignore */ });
        }}
        onBack={() => setPhase("settings")}
      />
    );
  }

  if (phase === "archived_campaigns") {
    return (
      <ArchivedCampaignsPhase
        theme={theme}
        archives={archivedCampaigns}
        statusMessage={archiveStatus}
        onUnarchive={(entry) => {
          apiClientRef.current.restoreArchivedCampaign(entry.name, entry.zipPath).then(() => {
            setArchiveStatus(`Restored "${entry.name}"`);
            refreshCampaigns();
            // Refresh archive list too
            apiClientRef.current.listArchivedCampaigns().then((resp) => setArchivedCampaigns(resp.archives)).catch(() => { /* ignore */ });
          }).catch((err) => {
            setErrorMessage(err instanceof Error ? err.message : String(err));
          });
        }}
        onBack={() => { setArchiveStatus(""); setPhase("settings"); }}
      />
    );
  }

  if (phase === "discord_settings") {
    return (
      <DiscordSettingsPhase
        theme={theme}
        currentSetting={discordEnabled}
        onSave={(enabled) => {
          apiClientRef.current.setDiscordSettings(enabled).then(() => {
            setDiscordEnabled(enabled);
            setPhase("settings");
          }).catch(() => {
            setPhase("settings");
          });
        }}
        onBack={() => setPhase("settings")}
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
      activeChoices,
      setActiveChoices,
      activeModal,
      setActiveModal,
      retryOverlay: clientState.lastError?.recoverable
        ? { status: 0, delaySec: 5 }
        : null,
      mode: clientState.mode,
      stateSnapshot,
      devModeEnabled,
      showVerbose,
      onReturnToMenu: returnToMenu,
    }}>
      <PlayingPhase key={`${activeCampaignId}-${sessionKey}`} />
    </GameProvider>
  );
}
