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
import { DiscordPresenceController } from "./services/discord/index.js";
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
import { setAgentClientState } from "./agent-state-ref.js";
import { loadClientSettings, saveClientSettings } from "./config/client-settings.js";
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
  /** Whether the Kitty keyboard protocol is active. */
  hasKittyProtocol?: boolean;
  /** Stdin filter chain for registering/unregistering input filters. */
  stdinFilterChain?: import("./tui/hooks/stdinFilterChain.js").StdinFilterChain | null;
  /** Detected terminal graphics-protocol support + cell-pixel size for inline images. */
  graphicsCaps?: import("./tui/image/capabilities.js").GraphicsCapabilities | null;
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

export function App({ serverUrl, playerId, campaignId, hasKittyProtocol, stdinFilterChain, graphicsCaps }: AppProps) {
  const [phase, setPhase] = useState<AppPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [clientState, setClientState] = useState<ClientState>(initialClientState);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState(campaignId ?? "");
  // Human-readable name set during setup→game transition; cleared when state:snapshot arrives.
  const [transitionName, setTransitionName] = useState("");
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
  const [discordEnabled, setDiscordEnabled] = useState<boolean>(true);
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [showVerbose, setShowVerbose] = useState(false);
  const [dmTurnLengthPctDefault, setDmTurnLengthPctDefault] = useState(80);
  const settingsLoaded = useRef(false);

  // Load persisted client settings on mount
  useEffect(() => {
    loadClientSettings().then((s) => {
      setShowVerbose(s.showVerbose);
      setDmTurnLengthPctDefault(s.dmTurnLengthPctDefault);
      settingsLoaded.current = true;
    });
    apiClientRef.current.getMachineSettings().then((s) => {
      setDevModeEnabled(s.devModeEnabled);
    }).catch(() => { /* best-effort — keep default */ });
    // Honor a persisted opt-out on every launch path (menu and direct-launch
    // via campaignId both depend on this firing before the controller-sync
    // effect activates Rich Presence).
    apiClientRef.current.getDiscordSettings().then((s) => {
      setDiscordEnabled(s.enabled);
    }).catch(() => { /* best-effort — keep default */ });
  }, []);

  // Persist client-only settings whenever they change (skip the initial load)
  useEffect(() => {
    if (!settingsLoaded.current) return;
    saveClientSettings({ showVerbose, dmTurnLengthPctDefault }).catch(() => { /* best-effort */ });
  }, [showVerbose, dmTurnLengthPctDefault]);
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
  const discordControllerRef = useRef<DiscordPresenceController>(new DiscordPresenceController());
  // Latest discordEnabled value, snapshotted into a ref so the WS event
  // closure (registered once on mount) sees the current opt-in state.
  const discordEnabledRef = useRef<boolean>(false);

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
        // Show session recap modal when the server flags it on resume.
        // Server emits this only once per clean session-end, so no need to
        // guard against repeat opens.
        if (snap.sessionRecap) {
          setActiveModal({ kind: "recap", lines: snap.sessionRecap.lines });
        }
      }
      setAgentClientState(next);
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
      // A rollback ends the session too, but here we want the player to see
      // what was restored before leaving play. The show_rollback_summary
      // activity:update arrives before session:ended over the ordered socket,
      // so rollbackSummary is already set. Raise the modal and stay in the
      // playing phase; its onDismiss runs returnToMenu (re-entry then loads
      // the restored state via session_resume).
      if (clientState.rollbackSummary) {
        setActiveModal({ kind: "rollback", summary: clientState.rollbackSummary });
      } else {
        returnToMenu();
      }
    }
  }, [clientState.sessionStale, clientState.sessionEnded, clientState.rollbackSummary, phase]);

  // Session-fatal-recoverable (issue #529): the active session is dead
  // (auth expired, model not found, classifier refusal) but the player can
  // fix it. Drop to menu with the verbatim cause in the existing red
  // banner. Mid-game flush + checkpoint happens server-side before the
  // error event lands, so the campaign reappears under "Resume" intact.
  // Trigger from any phase where a session could be running (playing,
  // starting, and the menu-with-a-just-started-setup-error case).
  useEffect(() => {
    if (clientState.lastError?.category !== "session-fatal-recoverable") return;
    const message = clientState.lastError.message;
    // Hide any modals that might be on top of the menu (saving overlay,
    // delete confirm, recap modal). `setActiveModal(null)` was added in
    // the same place returnToMenu uses for its own teardown.
    setActiveModal(null);
    setErrorMessage(message);
    if (phase === "playing" || phase === "starting") {
      // returnToMenu hits /endSession + waitForIdle. With session_fatal the
      // server has already torn down — the call no-ops but the idle poll
      // resolves quickly, so we don't need a separate cleanup path.
      returnToMenu();
    } else if (phase !== "menu") {
      // Settings / connections / etc — just bounce to the menu so the
      // player sees the banner.
      setPhase("menu");
    }
    // Clear the error from clientState so a subsequent session start
    // doesn't re-fire this effect from stale state.
    setClientState((prev) => ({ ...prev, lastError: null }));
    // returnToMenu intentionally omitted from deps: it's declared further
    // down via useCallback, and listing it triggers a temporal dead zone
    // at render time. The stale-session effect above uses the same
    // pattern (closure captures the latest value at run time).
  }, [clientState.lastError, phase]);

  // Handle setup → game transition: reset client state for new session.
  // The WebSocket stays connected — transitionToGame() broadcasts a fresh
  // state:snapshot to all connected clients after starting the new session.
  useEffect(() => {
    const newId = clientState.transitionCampaignId;
    if (!newId) return;
    setActiveCampaignId(newId);
    setTransitionName(clientState.transitionCampaignName ?? "");
    setSessionKey((k) => k + 1); // remount PlayingPhase
    // Preserve live UI state through the handoff so the transition is seamless:
    // - narrativeLines: setup conversation stays visible as the DM's opening streams in
    // - engineState: the session:transition handler sets this to "starting_session"
    //   so the activity line keeps spinning across the WS reconnect and the long
    //   first DM call (60-90s of LLM silence). Without this the UI reads as
    //   "control returned to player" until the first tool call lands.
    // - engineStateSince: timestamp paired with engineState; preserves the
    //   elapsed-time hint shown by ActivityLine.
    // - toolGlyphs: early tool activity stays visible until replaced
    setClientState((prev) => ({
      ...initialClientState(),
      narrativeLines: prev.narrativeLines,
      engineState: prev.engineState,
      engineStateSince: prev.engineStateSince,
      toolGlyphs: prev.toolGlyphs,
    }));
  }, [clientState.transitionCampaignId]);

  // Start a campaign (used by both auto-start and menu selection)
  const startCampaign = useCallback((id: string) => {
    setActiveCampaignId(id);
    setSessionKey((k) => k + 1);
    setPhase("starting");
    setNarrativeLines([]);
    setClientState(initialClientState());
    // Clear any lingering session-fatal banner (#529) — the player's
    // remediation action is starting a new session.
    setErrorMessage("");

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

  /**
   * Report the current terminal viewport to the server so the DM's
   * length-steering hint can adapt to the smallest connected client.
   *
   * Buffered: if the WS isn't open yet (mid-reconnect, or before the
   * very first connect), the latest dims are stashed and replayed in
   * the next `onConnect`.
   */
  const lastViewportRef = useRef<{ columns: number; rows: number; narrativeRows: number } | null>(null);
  const reportViewport = useCallback((dims: { columns: number; rows: number; narrativeRows: number }) => {
    lastViewportRef.current = dims;
    wsClientRef.current?.send({ type: "client:viewport", data: dims });
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
    const discordController = discordControllerRef.current;

    const ws = new WsClient({
      url: `${serverUrl.replace(/^http/, "ws")}/session/ws?role=player&player=${encodeURIComponent(playerId)}`,
      onEvent: (event) => {
        discordController.handle(event, discordEnabledRef.current);
        eventHandler(event);
      },
      onConnect: () => {
        // Replay the last-known viewport so the server's per-client dims
        // table picks it up immediately — including after a setup→game
        // session:transition where the server-side entry was cleared on
        // disconnect. Without the replay the DM would fall back to the
        // baked default on the first turn of the new session.
        if (lastViewportRef.current) {
          wsClientRef.current?.send({ type: "client:viewport", data: lastViewportRef.current });
        }
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

    return () => {
      ws.disconnect();
      void discordController.shutdown();
    };
  }, []);

  // Sync Discord opt-in changes into the controller (and the closure ref).
  useEffect(() => {
    const wasEnabled = discordEnabledRef.current;
    discordEnabledRef.current = discordEnabled;
    if (discordEnabled && !wasEnabled) discordControllerRef.current.enable();
    else if (!discordEnabled && wasEnabled) discordControllerRef.current.disable();
  }, [discordEnabled]);

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
        devModeEnabled={devModeEnabled}
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
        onToggleDevMode={() => {
          const next = !devModeEnabled;
          setDevModeEnabled(next);
          apiClientRef.current.setMachineSettings({ devModeEnabled: next }).catch(() => { /* best-effort */ });
        }}
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
        onStartChatGptLogin={() => apiClientRef.current.startChatGptLogin()}
        onPollChatGptLogin={(loginId) => apiClientRef.current.getChatGptLoginStatus(loginId)}
        onCancelChatGptLogin={(loginId) => apiClientRef.current.cancelChatGptLogin(loginId)}
        onRefreshConnections={() => {
          apiClientRef.current.listConnections().then((resp) => {
            setConnections(resp.connections);
            setTierAssignments(resp.tierAssignments);
          }).catch(() => { /* ignore */ });
        }}
        onFetchUsage={(id) => apiClientRef.current.getConnectionUsage(id)}
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
      campaignName: stateSnapshot?.campaignName ?? (transitionName || activeCampaignId),
      activePlayerIndex: stateSnapshot?.activePlayerIndex ?? 0,
      setActivePlayerIndex: () => { /* server manages this */ },
      engineState: clientState.engineState,
      engineStateSince: clientState.engineStateSince,
      toolGlyphs: clientState.toolGlyphs,
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
        ? {
            status: clientState.lastError.status ?? 0,
            delaySec: Math.ceil((clientState.lastError.delayMs ?? 5000) / 1000),
            attemptId: clientState.lastError.attemptId ?? 0,
          }
        : null,
      mode: clientState.mode,
      stateSnapshot,
      usageStatus: clientState.usageStatus,
      hasKittyProtocol,
      stdinFilterChain,
      graphicsCaps,
      devModeEnabled,
      showVerbose,
      dmTurnLengthPctDefault,
      onReturnToMenu: returnToMenu,
      reportViewport,
    }}>
      {/*
        Terminal graphics capabilities are detected once at startup
        (start-client.ts) and threaded through GameContext.graphicsCaps; the
        inline-image renderer in NarrativeArea reads them to pick a protocol
        (kitty / iTerm2 / sixel) or render nothing. No provider needed.
      */}
      <PlayingPhase key={`${activeCampaignId}-${sessionKey}`} />
    </GameProvider>
  );
}
