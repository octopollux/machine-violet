import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStdout, useInput, Text, Box } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

import { Layout } from "./tui/layout.js";
import { STYLES } from "./tui/frames/index.js";
import { GameMenu, MENU_ITEMS } from "./tui/modals/index.js";
import type { FrameStyle, StyleVariant } from "./types/tui.js";
import type { FileIO, SceneState } from "./agents/scene-manager.js";
import type { EngineState, EngineCallbacks } from "./agents/game-engine.js";
import { GameEngine } from "./agents/game-engine.js";
import type { TuiCommand, UsageStats } from "./agents/agent-loop.js";
import type { GameState } from "./agents/game-state.js";
import type { DMSessionState } from "./agents/dm-prompt.js";
import type { CampaignConfig } from "./types/config.js";
import { isConfigured, validateApiKeyFormat, buildEnvContent, buildAppConfig, getDefaultHomeDir } from "./config/first-launch.js";
import { listCampaigns } from "./config/main-menu.js";
import type { CampaignEntry } from "./config/main-menu.js";
import { fastPathSetup, fullSetup, buildCampaignConfig } from "./agents/setup-agent.js";
import type { SetupStep, SetupResult } from "./agents/setup-agent.js";
import { buildCampaignWorld } from "./agents/world-builder.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "./agents/player-manager.js";
import { createClocksState } from "./tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "./tools/combat/index.js";
import { createDecksState } from "./tools/cards/index.js";
import { CostTracker } from "./context/cost-tracker.js";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import { getModel } from "./config/models.js";

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
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  // --- Core state ---
  const [phase, setPhase] = useState<AppPhase>("loading");
  const [narrativeLines, setNarrativeLines] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Game state refs (stable across renders) ---
  const engineRef = useRef<GameEngine | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const costTracker = useRef(new CostTracker());
  const fileIO = useRef(createFileIO());
  // --- Menu/modal state ---
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [campaignSelectIndex, setCampaignSelectIndex] = useState(0);

  // --- Setup state ---
  const [setupPrompt, setSetupPrompt] = useState<SetupStep | null>(null);
  const setupResolveRef = useRef<((idx: number | string) => void) | null>(null);
  const [setupChoiceIndex, setSetupChoiceIndex] = useState(0);

  // --- First-launch state ---
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  // --- Display state ---
  const [campaignName, setCampaignName] = useState("");
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [style] = useState<FrameStyle>(STYLES[0]);
  const [variant, setVariant] = useState<StyleVariant>("exploration");

  // --- Config paths ---
  const getAppDir = useCallback(() => {
    // Use cwd as app dir for config files
    return process.cwd();
  }, []);

  const getEnvPath = useCallback(() => join(getAppDir(), ".env"), [getAppDir]);
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

    const envPath = getEnvPath();
    try {
      if (isConfigured(envPath, (p) => readFileSync(p, "utf-8"))) {
        setPhase("main_menu");
        loadCampaigns();
      } else {
        setPhase("first_launch");
      }
    } catch {
      setPhase("first_launch");
    }
  }, [phase, getEnvPath, loadCampaigns]);

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

  // --- Engine callbacks ---
  const buildCallbacks = useCallback((): EngineCallbacks => ({
    onNarrativeDelta(delta: string) {
      setNarrativeLines((prev) => {
        const lines = [...prev];
        if (lines.length === 0) {
          lines.push(delta);
        } else {
          lines[lines.length - 1] += delta;
        }
        return lines;
      });
    },
    onNarrativeComplete(_text: string) {
      setNarrativeLines((prev) => [...prev, ""]);
    },
    onStateChange(state: EngineState) {
      setEngineState(state);
      if (state === "waiting_input") {
        setVariant("exploration");
      } else if (state === "tool_running") {
        setVariant("combat");
      }
    },
    onTuiCommand(_cmd: TuiCommand) {
      // TUI commands from tools (choice modals, dice rolls, etc.)
      // Future: dispatch to modal system
    },
    onToolStart(_name: string) { /* activity shown via engineState */ },
    onToolEnd(_name: string) { /* activity shown via engineState */ },
    onExchangeDropped() { /* precis update handled internally */ },
    onUsageUpdate(usage: UsageStats) {
      costTracker.current.record(usage, getModel("large"));
    },
    onError(error: Error) {
      setErrorMsg(error.message);
      setNarrativeLines((prev) => [...prev, `[Error: ${error.message}]`]);
    },
  }), []);

  // --- Start engine for a campaign ---
  const startEngine = useCallback(async (config: CampaignConfig, campaignRoot: string) => {
    const gs = buildGameState(config, campaignRoot);
    gameStateRef.current = gs;

    const scene: SceneState = {
      sceneNumber: 1,
      slug: "opening",
      transcript: [],
      precis: "",
      sessionNumber: 1,
    };

    const sessionState: DMSessionState = {};
    const client = new Anthropic();

    const engine = new GameEngine({
      client,
      gameState: gs,
      scene,
      sessionState,
      fileIO: fileIO.current,
      callbacks: buildCallbacks(),
    });

    engineRef.current = engine;
    setCampaignName(config.name);
    setActivePlayerIndex(0);

    // Update shutdown context
    if (shutdownRef) {
      shutdownRef.current = {
        engine,
        campaignRoot,
        fileIO: fileIO.current,
        gitEnabled: config.recovery.enable_git,
      };
    }

    setNarrativeLines([`Welcome to ${config.name}.`, "", "The story begins..."]);
    setPhase("playing");

    // Send opening prompt to DM
    const activePlayer = getActivePlayer(gs);
    await engine.processInput(activePlayer.characterName, "[Session begins. Set the scene.]");
  }, [buildGameState, buildCallbacks, shutdownRef]);

  // --- Setup callback: presents choices to user via modal ---
  const setupCallback = useCallback(async (step: SetupStep): Promise<number | string> => {
    return new Promise<number | string>((resolve) => {
      setSetupPrompt(step);
      setSetupChoiceIndex(step.defaultIndex);
      setupResolveRef.current = resolve;
    });
  }, []);

  // --- Run setup flow ---
  const runSetup = useCallback(async (mode: "fast" | "full") => {
    setPhase("setup");

    const result: SetupResult = mode === "fast"
      ? await fastPathSetup(setupCallback)
      : await fullSetup(setupCallback);

    setSetupPrompt(null);
    setPhase("building");
    setNarrativeLines(["Building your world..."]);

    // Build campaign on disk
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
  }, [setupCallback, getConfigPath, startEngine]);

  // --- Resume a campaign ---
  const resumeCampaign = useCallback(async (entry: CampaignEntry) => {
    setPhase("building");
    setNarrativeLines(["Loading campaign..."]);

    try {
      const configRaw = await readFile(join(entry.path, "config.json"), "utf-8");
      const config: CampaignConfig = JSON.parse(configRaw);
      await startEngine(config, entry.path);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("main_menu");
    }
  }, [startEngine]);

  // --- Input handling ---
  useInput((input, key) => {
    // --- First Launch: API key input ---
    if (phase === "first_launch") {
      if (key.return) {
        const trimmed = apiKeyInput.trim();
        if (validateApiKeyFormat(trimmed)) {
          // Write .env and app config
          const appDir = getAppDir();
          try {
            mkdirSync(appDir, { recursive: true });
            writeFileSync(join(appDir, ".env"), buildEnvContent(trimmed));
            writeFileSync(join(appDir, "config.json"), buildAppConfig(getDefaultHomeDir()));
            process.env.ANTHROPIC_API_KEY = trimmed;
            setApiKeyError(null);
            setPhase("main_menu");
            loadCampaigns();
          } catch (e) {
            setApiKeyError(e instanceof Error ? e.message : "Failed to write config");
          }
        } else {
          setApiKeyError("Invalid key format (expected sk-ant-...)");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setApiKeyInput((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setApiKeyInput((v) => v + input);
        return;
      }
      return;
    }

    // --- Main Menu ---
    if (phase === "main_menu") {
      // Check if we're in campaign select sub-menu
      if (campaigns.length > 0 && campaignSelectIndex >= 0 && menuOpen) {
        if (key.upArrow) {
          setCampaignSelectIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setCampaignSelectIndex((i) => Math.min(campaigns.length - 1, i + 1));
          return;
        }
        if (key.return) {
          setMenuOpen(false);
          resumeCampaign(campaigns[campaignSelectIndex]);
          return;
        }
        if (key.escape) {
          setMenuOpen(false);
          return;
        }
        return;
      }

      if (input === "1") {
        runSetup("full");
        return;
      }
      if (input === "2" && campaigns.length > 0) {
        setMenuOpen(true);
        setCampaignSelectIndex(0);
        return;
      }
      if (input === "3") {
        runSetup("fast");
        return;
      }
      if (input === "q" || input === "Q") {
        process.exit(0);
      }
      return;
    }

    // --- Setup: choosing ---
    if (phase === "setup" && setupPrompt && setupResolveRef.current) {
      if (key.upArrow) {
        setSetupChoiceIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSetupChoiceIndex((i) => Math.min(setupPrompt.choices.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const resolve = setupResolveRef.current;
        setupResolveRef.current = null;
        resolve(setupChoiceIndex);
        return;
      }
      return;
    }

    // --- Playing ---
    if (phase === "playing") {
      // ESC toggles game menu
      if (key.escape) {
        setMenuOpen((v) => !v);
        setMenuIndex(0);
        return;
      }

      // Game menu navigation
      if (menuOpen) {
        if (key.upArrow) {
          setMenuIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setMenuIndex((i) => Math.min(MENU_ITEMS.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const item = MENU_ITEMS[menuIndex];
          if (item === "Resume") {
            setMenuOpen(false);
          } else if (item === "Save & Quit") {
            setMenuOpen(false);
            doShutdown();
          }
          // Other menu items: future
          return;
        }
        return;
      }

      // Tab: cycle player
      if (key.tab && gameStateRef.current) {
        const next = switchToNextPlayer(gameStateRef.current);
        setActivePlayerIndex(next.index);
        return;
      }

      // Text input
      if (key.return && inputValue.trim()) {
        const text = inputValue.trim();
        setInputValue("");
        if (engineRef.current && gameStateRef.current) {
          const active = getActivePlayer(gameStateRef.current);
          // Start a new narrative block for the response
          setNarrativeLines((prev) => [...prev, "", `> ${active.characterName}: ${text}`, ""]);
          engineRef.current.processInput(active.characterName, text);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInputValue((v) => v.slice(0, -1));
        return;
      }

      if (input && !key.ctrl && !key.meta && !key.return) {
        setInputValue((v) => v + input);
      }
      return;
    }
  });

  // --- Shutdown ---
  const doShutdown = useCallback(async () => {
    setPhase("shutting_down");
    setNarrativeLines(["Saving and shutting down..."]);

    await gracefulShutdown({
      engine: engineRef.current ?? undefined,
      campaignRoot: gameStateRef.current?.campaignRoot,
      fileIO: fileIO.current,
      gitEnabled: gameStateRef.current?.config.recovery.enable_git,
    });

    process.exit(0);
  }, []);

  // --- Render ---

  // First launch screen
  if (phase === "first_launch") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>TUI-RPG — First Time Setup</Text>
        <Text> </Text>
        <Text>Paste your Anthropic API key:</Text>
        <Text> </Text>
        <Text>{">"} {apiKeyInput.length > 0 ? apiKeyInput.slice(0, 10) + "..." + apiKeyInput.slice(-4) : "_"}</Text>
        {apiKeyError && <Text color="red">{apiKeyError}</Text>}
        <Text> </Text>
        <Text dimColor>Press Enter to confirm.</Text>
      </Box>
    );
  }

  // Main menu
  if (phase === "main_menu") {
    // Campaign select sub-menu
    if (menuOpen && campaigns.length > 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold>Continue Campaign</Text>
          <Text> </Text>
          {campaigns.map((c, i) => (
            <Text key={c.name}>
              {i === campaignSelectIndex ? ">" : " "} {c.name}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>Arrow keys to select, Enter to load, ESC to go back.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>TUI-RPG</Text>
        <Text> </Text>
        <Text>1) New Campaign</Text>
        <Text color={campaigns.length > 0 ? undefined : "gray"}>
          2) Continue Campaign {campaigns.length === 0 ? "(none found)" : `(${campaigns.length})`}
        </Text>
        <Text>3) Just Jump In</Text>
        <Text> </Text>
        <Text dimColor>Q to quit.</Text>
        {errorMsg && <Text color="red">{errorMsg}</Text>}
      </Box>
    );
  }

  // Setup flow
  if (phase === "setup" && setupPrompt) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>{setupPrompt.prompt}</Text>
        <Text> </Text>
        {setupPrompt.choices.map((c, i) => (
          <Text key={c.label}>
            {i === setupChoiceIndex ? ">" : " "} {c.label}
            {c.description ? <Text dimColor> — {c.description}</Text> : null}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>Arrow keys to select, Enter to confirm.</Text>
      </Box>
    );
  }

  // Building
  if (phase === "building") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Building your world...</Text>
      </Box>
    );
  }

  // Shutting down
  if (phase === "shutting_down") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Saving and shutting down...</Text>
      </Box>
    );
  }

  // Loading
  if (phase === "loading") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading...</Text>
      </Box>
    );
  }

  // --- Playing ---
  const gs = gameStateRef.current;
  const players = gs ? getPlayerEntries(gs) : [{ name: "Player", isAI: false }];
  const activeChar = gs ? getActivePlayer(gs).characterName : "Player";

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Layout
        dimensions={{ columns: cols, rows: menuOpen ? rows - MENU_ITEMS.length - 4 : rows }}
        style={style}
        variant={variant}
        narrativeLines={narrativeLines}
        modelineText={`${costTracker.current.formatTerse()} | ${campaignName}`}
        inputValue={inputValue}
        activeCharacterName={activeChar}
        players={players}
        activePlayerIndex={activePlayerIndex}
        campaignName={campaignName}
        resources={[]}
        turnHolder={activeChar}
        engineState={engineState}
      />
      {menuOpen && (
        <GameMenu
          variant={style.variants[variant]}
          width={cols}
          selectedIndex={menuIndex}
        />
      )}
    </Box>
  );
}
