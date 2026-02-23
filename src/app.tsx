import React, { useState, useEffect, useCallback, useRef } from "react";
import { Text, Box, useInput } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

import { STYLES, getStyle } from "./tui/frames/index.js";
import { markdownToTags } from "./tui/formatting.js";
import type { FrameStyle, StyleVariant, NarrativeLine, ActiveModal } from "./types/tui.js";
import type { FileIO, SceneState } from "./agents/scene-manager.js";
import { detectSceneState, classifyTranscriptEntry } from "./agents/scene-manager.js";
import { GameEngine } from "./agents/game-engine.js";
import type { GameState } from "./agents/game-state.js";
import type { DMSessionState } from "./agents/dm-prompt.js";
import { buildUIState } from "./agents/dm-prompt.js";
import type { CampaignConfig } from "./types/config.js";
import { buildEnvContent, buildAppConfig, getDefaultHomeDir } from "./config/first-launch.js";
import { listCampaigns } from "./config/main-menu.js";
import type { CampaignEntry } from "./config/main-menu.js";
import { buildCampaignConfig } from "./agents/setup-agent.js";
import type { SetupResult } from "./agents/setup-agent.js";
import { buildCampaignWorld } from "./agents/world-builder.js";
import { getActivePlayer } from "./agents/player-manager.js";
import { createClocksState } from "./tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "./tools/combat/index.js";
import { createDecksState } from "./tools/cards/index.js";
import { StatePersister } from "./context/state-persistence.js";
import { CostTracker } from "./context/cost-tracker.js";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import { createGitIO } from "./tools/git/isogit-adapter.js";
import { useGameCallbacks } from "./tui/hooks/useGameCallbacks.js";
import { useRawModeGuardian } from "./tui/hooks/useRawModeGuardian.js";
import { isDevMode, wrapFileIOWithDevLog } from "./config/dev-mode.js";
import { setContextDumpDir } from "./config/context-dump.js";

import { FirstLaunchPhase } from "./phases/FirstLaunchPhase.js";
import { MainMenuPhase } from "./phases/MainMenuPhase.js";
import { SetupPhase } from "./phases/SetupPhase.js";
import { PlayingPhase } from "./phases/PlayingPhase.js";
import { GameProvider } from "./tui/game-context.js";
import type { GameContextValue } from "./tui/game-context.js";

// --- Types ---

export type AppPhase =
  | "loading"
  | "first_launch"
  | "main_menu"
  | "setup"
  | "building"
  | "playing"
  | "shutting_down";

// --- Production FileIO ---

function createFileIO(): FileIO {
  return {
    async readFile(path: string) {
      return readFile(path, "utf-8");
    },
    async writeFile(path: string, content: string) {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true });
      await writeFile(path, content, "utf-8");
    },
    async appendFile(path: string, content: string) {
      await appendFile(path, content, "utf-8");
    },
    async mkdir(path: string) {
      await mkdir(path, { recursive: true });
    },
    async exists(path: string) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async listDir(path: string) {
      return readdir(path);
    },
  };
}

// --- App component ---

export interface AppProps {
  /** Ref that index.tsx sets for signal-handler shutdown */
  shutdownRef?: React.MutableRefObject<ShutdownContext>;
}

export default function App({ shutdownRef }: AppProps) {
  // --- Core state ---
  const [phase, setPhase] = useState<AppPhase>("loading");
  const [narrativeLines, setNarrativeLines] = useState<NarrativeLine[]>([]);
  const [engineState, setEngineState] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Game state refs (stable across renders) ---
  const engineRef = useRef<GameEngine | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const costTracker = useRef(new CostTracker());
  const fileIO = useRef(createFileIO());
  const clientRef = useRef<Anthropic | null>(null);
  const persisterRef = useRef<StatePersister | null>(null);

  // --- Campaigns ---
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);

  // --- Modal state (shared with PlayingPhase via props, set by buildCallbacks/dispatchTuiCommand) ---
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const activeModalRef = useRef<ActiveModal>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);

  // Auto-sync activeModalRef from state (engine callbacks need ref for synchronous reads)
  useEffect(() => { activeModalRef.current = activeModal; }, [activeModal]);

  // --- OOC state (shared with PlayingPhase, set by dispatchTuiCommand) ---
  const [oocActive, setOocActive] = useState(false);
  const previousVariantRef = useRef<StyleVariant>("exploration");

  // --- Dev mode state ---
  const [devActive, setDevActive] = useState(false);

  // --- Display state ---
  const [resources, setResources] = useState<string[]>([]);
  const [modelines, setModelines] = useState<Record<string, string>>({});
  const [campaignName, setCampaignName] = useState("");
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [style, setStyle] = useState<FrameStyle>(STYLES[0]);
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const variantRef = useRef<StyleVariant>("exploration");
  const hydratedRef = useRef(false);

  // Auto-sync variantRef (needed by dispatchTuiCommand's enter_ooc to save previous variant)
  useEffect(() => { variantRef.current = variant; }, [variant]);

  // Persist UI when style/variant/modelines change (skip during resume hydration)
  useEffect(() => {
    if (!hydratedRef.current) return;
    persisterRef.current?.persistUI({
      styleName: style.name,
      variant,
      modelines: Object.keys(modelines).length > 0 ? modelines : undefined,
    });
  }, [style, variant, modelines]);

  // Sync UI state to engine for DM prefix
  useEffect(() => {
    if (!hydratedRef.current) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setUIState(buildUIState({ modelines, styleName: style.name, variant }));
  }, [modelines, style, variant]);

  // --- Setup mode tracking ---
  const [setupMode, setSetupMode] = useState<"fast" | "full">("full");

  // --- First-launch: prefilled API key ---
  const [initialApiKey, setInitialApiKey] = useState("");

  // --- Config paths ---
  const getAppDir = useCallback(() => process.cwd(), []);
  const getConfigPath = useCallback(() => join(getAppDir(), "config.json"), [getAppDir]);

  // --- Load campaigns ---
  const loadCampaigns = useCallback(async () => {
    try {
      const configPath = getConfigPath();
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const campaignsDir = config.campaigns_dir || join(getDefaultHomeDir(), "campaigns");
      const found = await listCampaigns(
        campaignsDir,
        (p) => readdir(p),
        async (p) => {
          try { await stat(p); return true; } catch { return false; }
        },
      );
      setCampaigns(found);
    } catch {
      setCampaigns([]);
    }
  }, [getConfigPath]);

  // --- Loading phase ---
  useEffect(() => {
    if (phase !== "loading") return;

    const configPath = getConfigPath();
    try {
      readFileSync(configPath, "utf-8");
      setPhase("main_menu");
      loadCampaigns();
      return;
    } catch { /* config.json doesn't exist — first launch */ }

    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) setInitialApiKey(envKey);
    setPhase("first_launch");
  }, [phase, getConfigPath, loadCampaigns]);

  // --- Build game state from config ---
  const buildGameState = useCallback((config: CampaignConfig, campaignRoot: string): GameState => {
    return {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: createDefaultConfig(),
      decks: createDecksState(),
      config,
      campaignRoot,
      activePlayerIndex: 0,
    };
  }, []);

  // --- Raw mode: keep Ink's stdin listener alive across phase transitions ---
  // Without this, Ink removes its `readable` listener and calls `stdin.unref()`
  // whenever rawModeEnabledCount drops to 0 (i.e. between SetupPhase unmounting
  // and PlayingPhase mounting). This permanent hook keeps the count >= 1.
  const stableNoOp = useCallback(() => {}, []);
  useInput(stableNoOp, { isActive: phase !== "loading" && phase !== "shutting_down" });

  // --- Raw mode guardian: re-enable raw mode if OS/terminal disabled it (e.g. window blur) ---
  useRawModeGuardian({ enabled: phase !== "loading" && phase !== "shutting_down" });

  // --- Engine callbacks (extracted hook) ---
  const { buildCallbacks, dispatchTuiCommand } = useGameCallbacks({
    setNarrativeLines, setEngineState, setErrorMsg, setModelines,
    setResources, setStyle, setVariant, setActiveModal, setChoiceIndex,
    setOocActive,
    gameStateRef, clientRef, activeModalRef, variantRef, previousVariantRef,
    costTracker, fileIO,
  });

  // --- Start engine for a campaign ---
  const startEngine = useCallback(async (config: CampaignConfig, campaignRoot: string, isResume = false) => {
    const gs = buildGameState(config, campaignRoot);
    gameStateRef.current = gs;

    const scene: SceneState = isResume
      ? await detectSceneState(campaignRoot, fileIO.current)
      : { sceneNumber: 1, slug: "opening", transcript: [], precis: "", playerReads: [], sessionNumber: 1 };

    const sessionState: DMSessionState = {};
    const client = new Anthropic();
    clientRef.current = client;

    // Wrap FileIO with dev logging when dev mode is active
    const engineFileIO = isDevMode()
      ? wrapFileIOWithDevLog(fileIO.current, (msg) => setNarrativeLines((prev) => [...prev, { kind: "dev", text: msg }]))
      : fileIO.current;

    // Set up context dump directory when dev mode is active
    if (isDevMode()) {
      setContextDumpDir(join(campaignRoot, ".dev-mode", "campaigns", "context"));
      // Ensure .dev-mode is excluded from isomorphic-git snapshots
      const gitignorePath = join(campaignRoot, ".gitignore");
      void readFile(gitignorePath, "utf-8")
        .then((content) => {
          if (!content.includes(".dev-mode")) {
            return appendFile(gitignorePath, "\n.dev-mode/\n", "utf-8");
          }
        })
        .catch(() => writeFile(gitignorePath, ".dev-mode/\n", "utf-8"));
    }

    const gitIO = config.recovery.enable_git ? createGitIO() : undefined;

    const engine = new GameEngine({
      client,
      gameState: gs,
      scene,
      sessionState,
      fileIO: engineFileIO,
      callbacks: buildCallbacks(),
      gitIO,
    });

    engineRef.current = engine;
    persisterRef.current = new StatePersister(
      campaignRoot,
      fileIO.current,
      (error) => console.error("[state-persist]", error.message),
    );
    setCampaignName(config.name);
    setActivePlayerIndex(0);

    if (shutdownRef) {
      shutdownRef.current = {
        engine,
        campaignRoot,
        fileIO: fileIO.current,
        gitEnabled: config.recovery.enable_git,
        gitIO,
      };
    }

    if (isResume) {
      const persister = new StatePersister(
        campaignRoot,
        fileIO.current,
        (error) => console.error("[state-persist]", error.message),
      );
      const loaded = await persister.loadAll();

      if (loaded.combat) gs.combat = loaded.combat;
      if (loaded.clocks) gs.clocks = loaded.clocks;
      if (loaded.maps) gs.maps = loaded.maps;
      if (loaded.decks) gs.decks = loaded.decks;
      if (loaded.scene) {
        gs.activePlayerIndex = loaded.scene.activePlayerIndex;
        scene.precis = loaded.scene.precis;
        scene.playerReads = loaded.scene.playerReads;
        setActivePlayerIndex(loaded.scene.activePlayerIndex);
      }

      if (loaded.ui) {
        const restoredStyle = getStyle(loaded.ui.styleName);
        if (restoredStyle) setStyle(restoredStyle);
        setVariant(loaded.ui.variant);
        if (loaded.ui.modelines) setModelines(loaded.ui.modelines);
      }
      hydratedRef.current = true;

      // Resume interrupted cascade if present
      const pendingOp = await persister.loadPendingOp();
      if (pendingOp && pendingOp.step && pendingOp.step !== "done") {
        await engine.resumePendingTransition(pendingOp);
      }

      const recap = await engine.resumeSession();

      const transcriptLines: NarrativeLine[] = [];
      for (const entry of scene.transcript) {
        const { kind, text } = classifyTranscriptEntry(entry);
        if (kind === "dm") {
          // DM responses may contain \n\n paragraph breaks — split on
          // those for visual separation. Within each paragraph, \n is a
          // soft wrap from the LLM and gets joined with a space so
          // word-wrapping uses the actual terminal width.
          const paragraphs = text.split("\n\n");
          for (const para of paragraphs) {
            const joined = para.replace(/\n/g, " ");
            transcriptLines.push({ kind: "dm", text: markdownToTags(joined) });
            transcriptLines.push({ kind: "dm", text: "" });
          }
        } else {
          // Player input and tool results are single-line entries.
          transcriptLines.push({ kind, text });
        }
      }

      if (loaded.conversation && loaded.conversation.length > 0) {
        engine.hydrateConversation(loaded.conversation);

        setNarrativeLines([...transcriptLines, { kind: "system", text: `Welcome back to ${config.name}.` }, { kind: "dm", text: "" }]);
        setPhase("playing");
      } else {
        setNarrativeLines([...transcriptLines, { kind: "system", text: `Welcome back to ${config.name}.` }, { kind: "dm", text: "" }]);
        if (recap) {
          setActiveModal({ kind: "recap", lines: recap.split("\n") });
        }
        setPhase("playing");

        const activePlayer = getActivePlayer(gs);
        const resumeParts = ["[Session resumes. Continue the narrative where we left off."];
        if (config.premise) resumeParts.push(`Campaign premise: ${config.premise}`);
        const pc = config.players[0];
        if (pc) resumeParts.push(`The player character is ${pc.character}.`);
        resumeParts.push("Pick up naturally from the last scene — do NOT restart, re-introduce the setting, or recap what has already happened.");
        await engine.processInput(activePlayer.characterName, resumeParts.join(" ") + "]", { skipTranscript: true });
      }
    } else {
      hydratedRef.current = true;
      setNarrativeLines([{ kind: "system", text: `Welcome to ${config.name}.` }, { kind: "dm", text: "" }, { kind: "system", text: "The story begins..." }]);
      setPhase("playing");

      const activePlayer = getActivePlayer(gs);
      const openingParts = ["[Session begins. Set the scene."];
      if (config.premise) openingParts.push(`Campaign premise: ${config.premise}`);
      const pc = config.players[0];
      if (pc) openingParts.push(`The player character is ${pc.character}.`);
      await engine.processInput(activePlayer.characterName, openingParts.join(" ") + "]", { skipTranscript: true });
    }
  }, [buildGameState, buildCallbacks, shutdownRef]);

  // --- Finalize setup result into a running campaign ---
  const finalizeSetup = useCallback(async (result: SetupResult) => {
    setPhase("building");
    setNarrativeLines([{ kind: "system", text: "Building your world..." }]);

    try {
      const configPath = getConfigPath();
      let campaignsDir: string;
      try {
        const raw = readFileSync(configPath, "utf-8");
        const appConfig = JSON.parse(raw);
        campaignsDir = appConfig.campaigns_dir || join(getDefaultHomeDir(), "campaigns");
      } catch {
        campaignsDir = join(getDefaultHomeDir(), "campaigns");
      }

      const campaignRoot = await buildCampaignWorld(campaignsDir, result, fileIO.current);
      const config = buildCampaignConfig(result);
      await startEngine(config, campaignRoot);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("main_menu");
    }
  }, [getConfigPath, startEngine]);

  // --- Resume a campaign ---
  const resumeCampaign = useCallback(async (entry: CampaignEntry) => {
    setPhase("building");
    setNarrativeLines([{ kind: "system", text: "Loading campaign..." }]);

    try {
      const configRaw = await readFile(join(entry.path, "config.json"), "utf-8");
      const config: CampaignConfig = JSON.parse(configRaw);
      await startEngine(config, entry.path, true);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("main_menu");
    }
  }, [startEngine]);

  // --- Save & Exit: persist state without session-end housekeeping ---
  const doSaveAndExit = useCallback(async () => {
    setPhase("shutting_down");
    setNarrativeLines([{ kind: "system", text: "Saving and exiting..." }]);

    await gracefulShutdown({
      engine: engineRef.current ?? undefined,
      campaignRoot: gameStateRef.current?.campaignRoot,
      fileIO: fileIO.current,
      gitEnabled: gameStateRef.current?.config.recovery.enable_git,
      gitIO: shutdownRef?.current?.gitIO,
    });

    process.exit(0);
  }, [shutdownRef]);

  // --- End Session: full session-end housekeeping then exit ---
  const doEndSession = useCallback(async () => {
    setPhase("shutting_down");
    setNarrativeLines([{ kind: "system", text: "Ending session..." }]);

    // Run session-end housekeeping (precis, campaign log, changelog, calendar)
    if (engineRef.current) {
      try {
        const sm = engineRef.current.getSceneManager();
        const sessionNum = sm.getScene().sessionNumber;
        await engineRef.current.endSession(`Session ${sessionNum}`);
      } catch {
        // Best-effort — still proceed with low-level save
      }
    }

    await gracefulShutdown({
      engine: engineRef.current ?? undefined,
      campaignRoot: gameStateRef.current?.campaignRoot,
      fileIO: fileIO.current,
      gitEnabled: gameStateRef.current?.config.recovery.enable_git,
      gitIO: shutdownRef?.current?.gitIO,
    });

    process.exit(0);
  }, [shutdownRef]);

  // --- First-launch complete handler ---
  const handleFirstLaunchComplete = useCallback((apiKey: string) => {
    const appDir = getAppDir();
    try {
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, ".env"), buildEnvContent(apiKey));
      writeFileSync(join(appDir, "config.json"), buildAppConfig(getDefaultHomeDir()));
      process.env.ANTHROPIC_API_KEY = apiKey;
      setPhase("main_menu");
      loadCampaigns();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to write config");
    }
  }, [getAppDir, loadCampaigns]);

  // --- Render ---

  if (phase === "first_launch") {
    return <FirstLaunchPhase initialApiKey={initialApiKey} externalError={errorMsg} onComplete={handleFirstLaunchComplete} />;
  }

  if (phase === "main_menu") {
    return (
      <MainMenuPhase
        campaigns={campaigns}
        errorMsg={errorMsg}
        onNewCampaign={() => { setSetupMode("full"); setPhase("setup"); }}
        onJumpIn={() => { setSetupMode("fast"); setPhase("setup"); }}
        onResumeCampaign={resumeCampaign}
      />
    );
  }

  if (phase === "setup") {
    return (
      <SetupPhase
        mode={setupMode}
        style={style}
        costTracker={costTracker}
        onComplete={finalizeSetup}
        onCancel={() => setPhase("main_menu")}
        onError={(msg) => setErrorMsg(msg)}
      />
    );
  }

  if (phase === "building") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Building your world...</Text>
      </Box>
    );
  }

  if (phase === "shutting_down") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Saving and shutting down...</Text>
      </Box>
    );
  }

  if (phase === "loading") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading...</Text>
      </Box>
    );
  }

  // --- Playing ---
  const gameContext: GameContextValue = {
    engineRef, gameStateRef, clientRef, costTracker,
    narrativeLines, setNarrativeLines,
    style, variant, setVariant,
    campaignName, activePlayerIndex, setActivePlayerIndex,
    engineState, resources, modelines,
    activeModal, setActiveModal,
    choiceIndex, setChoiceIndex,
    oocActive, setOocActive, previousVariantRef,
    devModeEnabled: isDevMode(),
    devActive, setDevActive,
    dispatchTuiCommand,
    onShutdown: doSaveAndExit,
    onEndSession: doEndSession,
  };

  return (
    <GameProvider value={gameContext}>
      <PlayingPhase />
    </GameProvider>
  );
}
