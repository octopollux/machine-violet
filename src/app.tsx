import React, { useState, useEffect, useCallback, useRef } from "react";
import { Text, Box, useInput } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, readdir, stat, unlink, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { NarrativeLine, ActiveModal, RetryOverlay } from "./types/tui.js";
import type { StyleVariant, ResolvedTheme } from "./tui/themes/types.js";
import { BUILTIN_DEFINITIONS, resolveTheme, resetThemeCache } from "./tui/themes/index.js";
import type { FileIO, SceneState } from "./agents/scene-manager.js";
import { detectSceneState, classifyTranscriptEntry } from "./agents/scene-manager.js";
import { markdownToNarrativeLines, narrativeLinesToMarkdown } from "./context/display-log.js";
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
import { buildCampaignWorld, slugify as worldSlugify } from "./agents/world-builder.js";
import { getActivePlayer } from "./agents/player-manager.js";
import { createClocksState } from "./tools/clocks/index.js";
import { createCombatState } from "./tools/combat/index.js";
import { createDecksState } from "./tools/cards/index.js";
import { StatePersister } from "./context/state-persistence.js";
import type { LoadedState } from "./context/state-persistence.js";
import { CostTracker } from "./context/cost-tracker.js";
import type { ShutdownContext } from "./shutdown.js";
import { teardownGameSession } from "./teardown.js";
import { createGitIO } from "./tools/git/isogit-adapter.js";
import { useGameCallbacks } from "./tui/hooks/useGameCallbacks.js";
import { useRawModeGuardian } from "./tui/hooks/useRawModeGuardian.js";
import { useBatchedNarrativeLines } from "./tui/hooks/useBatchedNarrativeLines.js";
import { isDevMode, wrapFileIOWithDevLog } from "./config/dev-mode.js";
import { setContextDumpDir } from "./config/context-dump.js";
import { sandboxFileIO, campaignPaths } from "./tools/filesystem/index.js";

import { FirstLaunchPhase } from "./phases/FirstLaunchPhase.js";
import { MainMenuPhase } from "./phases/MainMenuPhase.js";
import { SetupPhase } from "./phases/SetupPhase.js";
import { PlayingPhase } from "./phases/PlayingPhase.js";
import { AddContentPhase } from "./phases/AddContentPhase.js";
import { validatePdfs, runIngestPipeline, runPerBookStages, runSharedStages, slugify } from "./content/index.js";
import type { ValidatedPdf, IngestProgress, ProcessingProgress } from "./content/index.js";
import { listAvailableSystems, readBundledRuleCard } from "./config/systems.js";
import type { AvailableSystem } from "./config/systems.js";
import { promoteCharacter } from "./agents/subagents/character-promotion.js";
import { processingPaths } from "./config/processing-paths.js";
import { norm } from "./utils/paths.js";
import { GameProvider } from "./tui/game-context.js";
import type { GameContextValue } from "./tui/game-context.js";

// --- Types ---

export type AppPhase =
  | "loading"
  | "first_launch"
  | "main_menu"
  | "add_content"
  | "setup"
  | "building"
  | "playing"
  | "returning_to_menu"
  | "shutting_down";

// --- Theme helpers ---

const DEFAULT_THEME_NAME = "gothic";
const DEFAULT_KEY_COLOR = "#8888aa";

function resolveDefaultTheme(variant: StyleVariant = "exploration", keyColor = DEFAULT_KEY_COLOR): ResolvedTheme {
  const def = BUILTIN_DEFINITIONS[DEFAULT_THEME_NAME] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, variant, keyColor);
}

function resolveNamedTheme(name: string, variant: StyleVariant, keyColor: string): ResolvedTheme {
  const def = BUILTIN_DEFINITIONS[name];
  if (def) return resolveTheme(def, variant, keyColor);
  return resolveDefaultTheme(variant, keyColor);
}

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
    async deleteFile(path: string) {
      await unlink(path);
    },
    async rmdir(path: string) {
      await rmdir(path);
    },
  };
}

// --- State hydration helpers (extracted from startEngine for readability) ---

/** Apply loaded state slices to the mutable GameState and SceneState. */
function hydrateGameState(gs: GameState, scene: SceneState, loaded: LoadedState): void {
  if (loaded.combat) gs.combat = loaded.combat;
  if (loaded.clocks) gs.clocks = loaded.clocks;
  if (loaded.maps) gs.maps = loaded.maps;
  if (loaded.decks) gs.decks = loaded.decks;
  if (loaded.scene) {
    gs.activePlayerIndex = loaded.scene.activePlayerIndex;
    scene.precis = loaded.scene.precis;
    scene.openThreads = loaded.scene.openThreads ?? "";
    scene.npcIntents = loaded.scene.npcIntents ?? "";
    scene.playerReads = loaded.scene.playerReads;
  }
}

/** Load display-log tail, with compat bridge for pre-display-log campaigns. */
async function loadDisplayHistory(
  persister: StatePersister,
  scene: SceneState,
): Promise<NarrativeLine[]> {
  let displayLogTail = await persister.loadDisplayLogTail(200);

  // TODO(compat): Remove after all dev campaigns have been migrated.
  // Bridge for pre-display-log campaigns: seed display-log.md from scene transcript.
  if (displayLogTail.length === 0 && scene.transcript.length > 0) {
    const migrated: NarrativeLine[] = [];
    for (const entry of scene.transcript) {
      const { kind, text } = classifyTranscriptEntry(entry);
      if (kind !== "dev") migrated.push({ kind, text });
    }
    const md = narrativeLinesToMarkdown(migrated);
    persister.appendDisplayLog(md);
    displayLogTail = md.trimEnd().split("\n");
  }

  return displayLogTail.length > 0
    ? markdownToNarrativeLines(displayLogTail)
    : [];
}

// --- Post-setup character sheet building ---

/**
 * Build an initial character sheet using the promoteCharacter subagent.
 * Called after buildCampaignWorld when we have system + character details.
 * Silently — no streaming (the "Building your world..." phase covers this).
 */
async function buildInitialSheet(
  campaignRoot: string,
  result: SetupResult,
  io: FileIO,
  homeDir: string,
): Promise<void> {
  const charSlug = worldSlugify(result.characterName);
  const charPath = norm(campaignPaths(campaignRoot).character(charSlug));

  // Read the stub we just wrote
  let stub: string;
  try {
    stub = await io.readFile(charPath);
  } catch {
    return; // stub doesn't exist — nothing to promote
  }

  // Load rule card: prefer user-processed, fall back to bundled
  let ruleCard: string | null = null;
  if (result.system) {
    const sysPaths = processingPaths(homeDir, result.system);
    try {
      ruleCard = await io.readFile(norm(sysPaths.ruleCard));
    } catch {
      ruleCard = readBundledRuleCard(result.system);
    }
  }

  if (!ruleCard) return; // no rule card — can't build a proper sheet

  const client = new Anthropic();
  try {
    const { updatedSheet } = await promoteCharacter(client, {
      characterSheet: stub,
      systemRules: ruleCard,
      context: `Build initial character sheet: ${result.characterDetails}`,
      characterName: result.characterName,
    });
    if (updatedSheet) {
      await io.writeFile(charPath, updatedSheet);
    }
  } catch {
    // Best-effort — the stub is still a valid character file
  }
}

// --- App component ---

export interface AppProps {
  /** Ref that index.tsx sets for signal-handler shutdown */
  shutdownRef?: React.MutableRefObject<ShutdownContext>;
}

export default function App({ shutdownRef }: AppProps) {
  // --- Core state ---
  const [phase, setPhase] = useState<AppPhase>("loading");
  const { lines: narrativeLines, setLines: setNarrativeLines } = useBatchedNarrativeLines();
  const [engineState, setEngineState] = useState<string | null>(null);
  const [toolGlyphs, setToolGlyphs] = useState<import("./tui/activity.js").ToolGlyph[]>([]);
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

  // --- Systems ---
  const [systems, setSystems] = useState<AvailableSystem[]>([]);

  // --- Modal state (shared with PlayingPhase via props, set by buildCallbacks/dispatchTuiCommand) ---
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [retryOverlay, setRetryOverlay] = useState<RetryOverlay | null>(null);
  const activeModalRef = useRef<ActiveModal>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);

  // Auto-sync activeModalRef from state (engine callbacks need ref for synchronous reads)
  useEffect(() => { activeModalRef.current = activeModal; }, [activeModal]);

  // --- Mode session state (replaces separate oocActive/devActive booleans) ---
  const [activeSession, setActiveSession] = useState<import("./tui/game-context.js").ModeSession | null>(null);
  const previousVariantRef = useRef<StyleVariant>("exploration");

  // --- Display state ---
  const [resources, setResources] = useState<string[]>([]);
  const [modelines, setModelines] = useState<Record<string, string>>({});
  const [campaignName, setCampaignName] = useState("");
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);

  // --- Theme state (replaces old style/variant) ---
  const [themeName, setThemeName] = useState(DEFAULT_THEME_NAME);
  const [keyColor, setKeyColor] = useState(DEFAULT_KEY_COLOR);
  const [variant, setVariant] = useState<StyleVariant>("exploration");
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveDefaultTheme());
  const variantRef = useRef<StyleVariant>("exploration");

  // Gate for UI persistence effects. Must be set to true ONLY after all
  // hydrated state (themeName, variant, modelines) has been applied via
  // their respective setters in the same synchronous block. React batches
  // the state updates, so the effects below won't fire until after the
  // block yields — by which time all values are correct.
  const hydratedRef = useRef(false);

  // Re-resolve theme when variant, themeName, or keyColor changes
  useEffect(() => {
    resetThemeCache();
    setTheme(resolveNamedTheme(themeName, variant, keyColor));
  }, [themeName, variant, keyColor]);

  // Auto-sync variantRef (needed by dispatchTuiCommand's enter_ooc to save previous variant)
  useEffect(() => { variantRef.current = variant; }, [variant]);

  // Persist UI when theme/variant/keyColor/modelines change (skip until hydration complete)
  useEffect(() => {
    if (!hydratedRef.current) return;
    persisterRef.current?.persistUI({
      styleName: themeName,
      variant,
      keyColor: keyColor !== DEFAULT_KEY_COLOR ? keyColor : undefined,
      modelines: Object.keys(modelines).length > 0 ? modelines : undefined,
    });
  }, [themeName, variant, keyColor, modelines]);

  // Sync UI state to engine for DM prefix
  useEffect(() => {
    if (!hydratedRef.current) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setUIState(buildUIState({ modelines, styleName: themeName, variant }));
  }, [modelines, themeName, variant]);


  // --- First-launch: prefilled API key ---
  const [initialApiKey, setInitialApiKey] = useState("");

  // --- Config paths ---
  const getAppDir = useCallback(() => process.cwd(), []);
  const getConfigPath = useCallback(() => join(getAppDir(), "config.json"), [getAppDir]);

  // --- Load campaigns and systems ---
  const loadCampaigns = useCallback(async () => {
    try {
      const configPath = getConfigPath();
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      const campaignsDir = config.campaigns_dir || join(getDefaultHomeDir(), "campaigns");
      const homeDir: string = config.home_dir || getDefaultHomeDir();
      const found = await listCampaigns(
        campaignsDir,
        (p) => readdir(p),
        async (p) => {
          try { await stat(p); return true; } catch { return false; }
        },
        (p) => readFile(p, "utf-8"),
      );
      setCampaigns(found);

      // Load available systems in parallel
      const availSystems = await listAvailableSystems(fileIO.current, homeDir);
      setSystems(availSystems);
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
    const raw = readFileSync(getConfigPath(), "utf-8");
    const appCfg = JSON.parse(raw);
    const hd: string = appCfg.home_dir || getDefaultHomeDir();
    return {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: config.combat,
      decks: createDecksState(),
      config,
      campaignRoot,
      homeDir: hd,
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
    };
  }, [getConfigPath]);

  // --- Raw mode: keep Ink's stdin listener alive across phase transitions ---
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op to keep raw mode alive
  const stableNoOp = useCallback(() => {}, []);
  useInput(stableNoOp, { isActive: phase !== "loading" && phase !== "shutting_down" && phase !== "returning_to_menu" });

  // --- Raw mode guardian: re-enable raw mode if OS/terminal disabled it (e.g. window blur) ---
  useRawModeGuardian({ enabled: phase !== "loading" && phase !== "shutting_down" && phase !== "returning_to_menu" });

  // Ref-based indirection: doSaveAndReturn is defined later but useGameCallbacks
  // needs it now. The ref is updated after doSaveAndReturn is created.
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- placeholder until doSaveAndReturn is defined
  const returnToMenuRef = useRef<() => void>(() => {});

  // --- Engine callbacks (extracted hook) ---
  const { buildCallbacks, dispatchTuiCommand } = useGameCallbacks({
    onReturnToMenu: () => returnToMenuRef.current(),
    setNarrativeLines, setEngineState, setErrorMsg, setModelines,
    setResources, setVariant, setThemeName, setKeyColor,
    setActiveModal, setChoiceIndex,
    setActiveSession, setRetryOverlay, setToolGlyphs,
    gameStateRef, clientRef, engineRef, activeModalRef, variantRef, previousVariantRef,
    costTracker, fileIO,
  });

  // --- Start engine for a campaign ---
  const startEngine = useCallback(async (config: CampaignConfig, campaignRoot: string, isResume = false) => {
    const gs = buildGameState(config, campaignRoot);
    gameStateRef.current = gs;

    const scene: SceneState = isResume
      ? await detectSceneState(campaignRoot, fileIO.current)
      : { sceneNumber: 1, slug: "opening", transcript: [], precis: "", openThreads: "", npcIntents: "", playerReads: [], sessionNumber: 1 };

    const sessionState: DMSessionState = {};

    // Load campaign-scope DM notes (if they exist)
    try {
      const dmNotesPath = campaignPaths(campaignRoot).dmNotes;
      if (await fileIO.current.exists(dmNotesPath)) {
        sessionState.dmNotes = await fileIO.current.readFile(dmNotesPath);
      }
    } catch { /* ignore — file may not exist yet */ }

    const client = new Anthropic();
    clientRef.current = client;

    // Sandbox FileIO to campaign root (and future content roots)
    const campaignsDir = dirname(campaignRoot);
    const sandboxed = sandboxFileIO(fileIO.current, [campaignRoot, campaignsDir]);

    // Wrap FileIO with dev logging when dev mode is active
    const engineFileIO = isDevMode()
      ? wrapFileIOWithDevLog(sandboxed, (msg) => setNarrativeLines((prev) => [...prev, { kind: "dev", text: msg }]))
      : sandboxed;

    // Set up context dump directory when dev mode is active
    if (isDevMode()) {
      setContextDumpDir(join(campaignRoot, ".dev-mode", "campaigns", "context"));
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
    // Use the engine's own persister for UI persistence effects — single
    // instance shared across engine writes and TUI-driven persists.
    persisterRef.current = engine.getPersister();
    setCampaignName(config.name);
    process.stdout.write(`\x1b]0;${config.name}\x07`);
    setActivePlayerIndex(0);

    if (shutdownRef) {
      const ctx = shutdownRef.current;
      ctx.engine = engine;
      ctx.campaignRoot = campaignRoot;
      ctx.fileIO = fileIO.current;
      ctx.gitEnabled = config.recovery.enable_git;
      ctx.gitIO = gitIO;
    }

    if (isResume) {
      await resumeEngine(engine, config, gs, scene);
    } else {
      await startNewGame(engine, config, gs);
    }
  }, [buildGameState, buildCallbacks, shutdownRef]);

  /** Resume an existing campaign: hydrate state, restore UI, show history. */
  async function resumeEngine(
    engine: GameEngine,
    config: CampaignConfig,
    gs: GameState,
    scene: SceneState,
  ): Promise<void> {
    const persister = engine.getPersister();
    if (!persister) throw new Error("Engine has no persister after start");
    const loaded = await persister.loadAll();

    hydrateGameState(gs, scene, loaded);
    if (loaded.scene) setActivePlayerIndex(loaded.scene.activePlayerIndex);
    if (loaded.conversation) engine.seedConversation(loaded.conversation);

    // Restore theme — fall back to default if the persisted name is unknown
    if (loaded.ui) {
      if (BUILTIN_DEFINITIONS[loaded.ui.styleName]) {
        setThemeName(loaded.ui.styleName);
      }
      setVariant(loaded.ui.variant);
      if (loaded.ui.keyColor) setKeyColor(loaded.ui.keyColor);
      if (loaded.ui.modelines) setModelines(loaded.ui.modelines);
    }

    // Mark hydration complete. All state setters above are in this
    // synchronous block, so React's batched effects will see the
    // correct values when they fire after this function yields.
    hydratedRef.current = true;

    // Resume interrupted cascade if present
    const pendingOp = await persister.loadPendingOp();
    if (pendingOp && pendingOp.step && pendingOp.step !== "done") {
      await engine.resumePendingTransition(pendingOp);
    }

    const recap = await engine.resumeSession();

    // Load display log tail for TUI — shows the player what happened before
    const historyLines = await loadDisplayHistory(persister, scene);

    setNarrativeLines([...historyLines, { kind: "system", text: `Welcome back to ${config.name}.` }, { kind: "dm", text: "" }]);

    // Only show the recap modal when there's a session recap available
    // (i.e. a full session boundary happened). The player has visual
    // continuity via the display log and initiates the first turn.
    if (recap) {
      setActiveModal({ kind: "recap", lines: recap.split("\n") });
    }
    setPhase("playing");
  }

  /** Start a brand-new campaign: show welcome, prompt DM to set the scene. */
  async function startNewGame(
    engine: GameEngine,
    config: CampaignConfig,
    gs: GameState,
  ): Promise<void> {
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

      const homeDir = getDefaultHomeDir();
      const campaignRoot = await buildCampaignWorld(campaignsDir, result, fileIO.current, homeDir);

      // Build initial character sheet if we have system + details
      if (result.system && result.characterDetails) {
        await buildInitialSheet(campaignRoot, result, fileIO.current, homeDir);
      }

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

  // --- Reset all React/ref state for a clean return to menu ---
  const resetGameState = useCallback(() => {
    engineRef.current = null;
    gameStateRef.current = null;
    clientRef.current = null;
    persisterRef.current = null;
    hydratedRef.current = false;

    setNarrativeLines([]);
    setEngineState(null);
    setToolGlyphs([]);
    setActiveModal(null);
    setRetryOverlay(null);
    setChoiceIndex(0);
    setActiveSession(null);
    setResources([]);
    setModelines({});
    setCampaignName("");
    setActivePlayerIndex(0);
    setErrorMsg(null);

    // Reset theme to defaults
    setThemeName(DEFAULT_THEME_NAME);
    setKeyColor(DEFAULT_KEY_COLOR);
    setVariant("exploration");

    if (shutdownRef) {
      const ctx = shutdownRef.current;
      ctx.engine = undefined;
      ctx.campaignRoot = undefined;
      ctx.fileIO = undefined;
      ctx.gitEnabled = undefined;
      ctx.gitIO = undefined;
    }
  }, [shutdownRef]);

  // --- Save & Return to Menu ---
  const doSaveAndReturn = useCallback(() => {
    setPhase("returning_to_menu");

    void (async () => {
      try {
        await teardownGameSession({
          engine: engineRef.current ?? undefined,
          campaignRoot: gameStateRef.current?.campaignRoot,
          fileIO: fileIO.current,
          gitEnabled: gameStateRef.current?.config.recovery.enable_git,
          gitIO: shutdownRef?.current?.gitIO,
        });
      } catch {
        // Best-effort — still return to menu
      }

      resetGameState();
      await loadCampaigns();
      setPhase("main_menu");
    })();
  }, [shutdownRef, resetGameState, loadCampaigns]);

  // Keep the ref in sync so useGameCallbacks' dispatchTuiCommand always calls the latest version
  returnToMenuRef.current = doSaveAndReturn;

  // --- End Session & Return: full session-end housekeeping then return ---
  const doEndSessionAndReturn = useCallback(() => {
    setPhase("returning_to_menu");

    void (async () => {
      if (engineRef.current) {
        try {
          const sm = engineRef.current.getSceneManager();
          const sessionNum = sm.getScene().sessionNumber;
          await engineRef.current.endSession(`Session ${sessionNum}`);
        } catch {
          // Best-effort — still proceed with low-level save
        }
      }

      try {
        await teardownGameSession({
          engine: engineRef.current ?? undefined,
          campaignRoot: gameStateRef.current?.campaignRoot,
          fileIO: fileIO.current,
          gitEnabled: gameStateRef.current?.config.recovery.enable_git,
          gitIO: shutdownRef?.current?.gitIO,
        });
      } catch {
        // Best-effort — still return to menu
      }

      resetGameState();
      await loadCampaigns();
      setPhase("main_menu");
    })();
  }, [shutdownRef, resetGameState, loadCampaigns]);

  // --- Quit: hard exit ---
  const doQuit = useCallback(() => {
    process.exit(0);
  }, []);

  // --- Add Content state ---
  const [contentStatusMsg, setContentStatusMsg] = useState<string | null>(null);

  const handleAddContentSubmit = useCallback((systemSlug: string, systemName: string, pdfs: ValidatedPdf[]) => {
    (async () => {
      try {
        const configPath = getConfigPath();
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        const homeDir: string = config.home_dir || getDefaultHomeDir();
        const projectRoot = process.cwd();

        // Phase 1: Text extraction
        const onIngestProgress = (progress: IngestProgress) => {
          setContentStatusMsg(progress.message ?? `Extracting text...`);
        };
        setContentStatusMsg("Extracting text...");

        const jobs = await runIngestPipeline(fileIO.current, homeDir, systemSlug, pdfs, onIngestProgress);

        // Phase 2: Per-book stages (classifier + extractors) for each PDF
        const client = new Anthropic();
        const onProcessingProgress = (progress: ProcessingProgress) => {
          setContentStatusMsg(progress.message);
        };

        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          const jobSlug = slugify(pdfs[i].baseName);

          await runPerBookStages({
            client,
            io: fileIO.current,
            homeDir,
            collectionSlug: systemSlug,
            jobSlug,
            totalPages: job.totalPages,
            onProgress: onProcessingProgress,
          });
        }

        // Phase 3: Shared stages (merge + index + rule card) once across all entities
        await runSharedStages({
          client,
          io: fileIO.current,
          homeDir,
          collectionSlug: systemSlug,
          projectRoot,
          onProgress: onProcessingProgress,
        });

        setContentStatusMsg("Done! Returning to menu...");
        setTimeout(async () => {
          setContentStatusMsg(null);
          setErrorMsg(null);
          await loadCampaigns();
          setPhase("main_menu");
        }, 2000);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Content import failed");
        setContentStatusMsg(null);
        setPhase("main_menu");
      }
    })();
  }, [getConfigPath, fileIO, loadCampaigns]);

  const handleValidatePdf = useCallback(async (path: string): Promise<ValidatedPdf> => {
    const results = await validatePdfs([path]);
    return results[0];
  }, []);

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
        theme={theme}
        campaigns={campaigns}
        errorMsg={errorMsg}
        onNewCampaign={() => setPhase("setup")}
        onResumeCampaign={resumeCampaign}
        onAddContent={() => setPhase("add_content")}
        onQuit={doQuit}
      />
    );
  }

  if (phase === "add_content") {
    return (
      <AddContentPhase
        theme={theme}
        systems={systems}
        onSubmit={handleAddContentSubmit}
        onCancel={() => { setErrorMsg(null); setContentStatusMsg(null); setPhase("main_menu"); }}
        validatePdf={handleValidatePdf}
        errorMsg={errorMsg}
        statusMsg={contentStatusMsg}
      />
    );
  }

  if (phase === "setup") {
    return (
      <SetupPhase
        theme={theme}
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

  if (phase === "returning_to_menu") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Saving...</Text>
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
    theme, variant, setVariant, setTheme, keyColor, setKeyColor,
    campaignName, activePlayerIndex, setActivePlayerIndex,
    engineState, toolGlyphs, resources, modelines,
    activeModal, setActiveModal,
    choiceIndex, setChoiceIndex,
    retryOverlay,
    activeSession, setActiveSession, previousVariantRef,
    devModeEnabled: isDevMode(),
    dispatchTuiCommand,
    onReturnToMenu: doSaveAndReturn,
    onEndSessionAndReturn: doEndSessionAndReturn,
  };

  return (
    <GameProvider value={gameContext}>
      <PlayingPhase />
    </GameProvider>
  );
}
