import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStdout, useInput, Text, Box } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

import { Layout } from "./tui/layout.js";
import { STYLES, getStyle } from "./tui/frames/index.js";
import { GameMenu, MENU_ITEMS, ChoiceModal, DiceRollModal, CharacterSheetModal, SessionRecapModal } from "./tui/modals/index.js";
import type { FrameStyle, StyleVariant } from "./types/tui.js";
import type { FileIO, SceneState } from "./agents/scene-manager.js";
import type { EngineState, EngineCallbacks } from "./agents/game-engine.js";
import { GameEngine } from "./agents/game-engine.js";
import type { TuiCommand, UsageStats } from "./agents/agent-loop.js";
import type { GameState } from "./agents/game-state.js";
import type { DMSessionState } from "./agents/dm-prompt.js";
import type { CampaignConfig } from "./types/config.js";
import { validateApiKeyFormat, buildEnvContent, buildAppConfig, getDefaultHomeDir } from "./config/first-launch.js";
import { listCampaigns } from "./config/main-menu.js";
import type { CampaignEntry } from "./config/main-menu.js";
import { fastPathSetup, buildCampaignConfig } from "./agents/setup-agent.js";
import type { SetupStep, SetupResult } from "./agents/setup-agent.js";
import { createSetupConversation } from "./agents/subagents/setup-conversation.js";
import type { SetupConversation } from "./agents/subagents/setup-conversation.js";
import { buildCampaignWorld } from "./agents/world-builder.js";
import { getActivePlayer, switchToNextPlayer, getPlayerEntries } from "./agents/player-manager.js";
import { createClocksState } from "./tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "./tools/combat/index.js";
import { createDecksState } from "./tools/cards/index.js";
import { CostTracker } from "./context/cost-tracker.js";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import { getModel } from "./config/models.js";
import { campaignPaths } from "./tools/filesystem/index.js";
import { createGitIO } from "./tools/git/isogit-adapter.js";
import { shouldGenerateChoices, generateChoices } from "./agents/subagents/choice-generator.js";
import { enterOOC } from "./agents/subagents/ooc-mode.js";

// --- Types ---

export type ActiveModal =
  | { kind: "choice"; prompt: string; choices: string[] }
  | { kind: "dice"; expression: string; rolls: number[]; kept?: number[]; total: number; reason?: string }
  | { kind: "character_sheet"; content: string }
  | { kind: "recap"; lines: string[] }
  | null;

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
  const [engineState, setEngineState] = useState<string | null>(null);
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
  const [mainMenuIndex, setMainMenuIndex] = useState(0);

  // --- Modal state ---
  const [activeModal, _setActiveModal] = useState<ActiveModal>(null);
  const activeModalRef = useRef<ActiveModal>(null);
  const setActiveModal = useCallback((modal: ActiveModal) => {
    _setActiveModal(modal);
    activeModalRef.current = modal;
  }, []);

  // --- Additional display state ---
  const [resources, setResources] = useState<string[]>([]);
  const [modelineOverride, setModelineOverride] = useState<string | null>(null);
  const [oocActive, setOocActive] = useState(false);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const clientRef = useRef<Anthropic | null>(null);

  // --- Setup state ---
  const [setupPrompt, setSetupPrompt] = useState<SetupStep | null>(null);
  const setupResolveRef = useRef<((idx: number | string) => void) | null>(null);
  const [setupChoiceIndex, setSetupChoiceIndex] = useState(0);
  // Conversational setup (full path)
  const setupConvoRef = useRef<SetupConversation | null>(null);
  const [setupConvoLines, setSetupConvoLines] = useState<string[]>([]);
  const [setupConvoInput, setSetupConvoInput] = useState("");
  const [setupConvoBusy, setSetupConvoBusy] = useState(false);

  // --- First-launch state ---
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  // --- Display state ---
  const [campaignName, setCampaignName] = useState("");
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [style, setStyle] = useState<FrameStyle>(STYLES[0]);
  const [variant, setVariant] = useState<StyleVariant>("exploration");

  // --- Config paths ---
  const getAppDir = useCallback(() => {
    // Use cwd as app dir for config files
    return process.cwd();
  }, []);

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

    // If config.json exists, skip to main menu (returning user)
    const configPath = getConfigPath();
    try {
      readFileSync(configPath, "utf-8");
      setPhase("main_menu");
      loadCampaigns();
      return;
    } catch { /* config.json doesn't exist — first launch */ }

    // Prefill API key from .env / environment if available
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) setApiKeyInput(envKey);
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

  // --- TUI command dispatch ---
  const dispatchTuiCommand = useCallback((cmd: TuiCommand) => {
    switch (cmd.type) {
      case "update_modeline":
        setModelineOverride(cmd.text as string);
        break;
      case "set_ui_style": {
        setVariant(cmd.variant as StyleVariant);
        const found = getStyle(cmd.style as string);
        if (found) setStyle(found);
        break;
      }
      case "set_display_resources":
        setResources(cmd.resources as string[]);
        break;
      case "present_choices": {
        const choices = cmd.choices as string[];
        if (choices && choices.length > 0) {
          setChoiceIndex(0);
          setActiveModal({ kind: "choice", prompt: (cmd.prompt as string) || "What do you do?", choices });
        }
        break;
      }
      case "present_roll":
        setActiveModal({
          kind: "dice",
          expression: cmd.expression as string,
          rolls: cmd.rolls as number[],
          kept: cmd.kept as number[] | undefined,
          total: cmd.total as number,
          reason: cmd.reason as string | undefined,
        });
        break;
      case "show_character_sheet": {
        const charName = cmd.character as string;
        const gs = gameStateRef.current;
        if (gs) {
          const path = campaignPaths(gs.campaignRoot).character(charName);
          fileIO.current.readFile(path).then((content) => {
            setActiveModal({ kind: "character_sheet", content });
          }).catch(() => {
            setActiveModal({ kind: "character_sheet", content: `[Could not load character sheet for ${charName}]` });
          });
        }
        break;
      }
      case "enter_ooc":
        setOocActive(true);
        setVariant("ooc");
        break;
    }
  }, [setActiveModal]);

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
    onNarrativeComplete(text: string) {
      setNarrativeLines((prev) => [...prev, ""]);

      // Auto-generate choices if configured
      const gs = gameStateRef.current;
      if (gs && clientRef.current) {
        const dmProvided = activeModalRef.current?.kind === "choice";
        if (shouldGenerateChoices(gs.config.choices.campaign_default, dmProvided)) {
          const activePlayer = getActivePlayer(gs);
          generateChoices(clientRef.current, text, activePlayer.characterName).then((result) => {
            // Only show if no other modal is active
            if (!activeModalRef.current && result.choices.length > 0) {
              setChoiceIndex(0);
              setActiveModal({ kind: "choice", prompt: "What do you do?", choices: result.choices });
            }
            costTracker.current.record(result.usage, getModel("small"));
          }).catch(() => { /* best-effort */ });
        }
      }
    },
    onStateChange(state: EngineState) {
      setEngineState(state);
      if (state === "waiting_input") {
        setVariant("exploration");
      } else if (state === "tool_running") {
        setVariant("combat");
      }
    },
    onTuiCommand(cmd: TuiCommand) {
      dispatchTuiCommand(cmd);
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
    onRetry(status: number, delayMs: number) {
      setEngineState(`retry:${status}:${Math.ceil(delayMs / 1000)}`);
    },
  }), [dispatchTuiCommand, setActiveModal]);

  // --- Detect latest scene/session numbers from campaign directory ---
  const detectSceneState = useCallback(async (campaignRoot: string): Promise<SceneState> => {
    const paths = campaignPaths(campaignRoot);
    const scenesDir = join(campaignRoot, "campaign", "scenes");
    const recapsDir = join(campaignRoot, "campaign", "session-recaps");

    let maxScene = 0;
    let lastSlug = "opening";
    try {
      const entries = await readdir(scenesDir);
      for (const entry of entries) {
        // Scene dirs look like "001-opening", "002-tavern"
        const match = entry.match(/^(\d+)-(.+)$/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxScene) {
            maxScene = n;
            lastSlug = match[2];
          }
        }
      }
    } catch { /* no scenes dir yet */ }

    let maxSession = 0;
    try {
      const entries = await readdir(recapsDir);
      for (const entry of entries) {
        // Recap files look like "session-001.md"
        const match = entry.match(/^session-(\d+)\.md$/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxSession) maxSession = n;
        }
      }
    } catch { /* no recaps dir yet */ }

    // Load the last scene's transcript back for context
    let transcript: string[] = [];
    if (maxScene > 0) {
      try {
        const tPath = paths.sceneTranscript(maxScene, lastSlug);
        const raw = await readFile(tPath, "utf-8");
        // Parse transcript: each entry is separated by double newlines, skip the "# Scene N" header
        const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
        transcript = blocks.filter((b) => !b.startsWith("# Scene"));
      } catch { /* no transcript yet */ }
    }

    return {
      sceneNumber: Math.max(1, maxScene),
      slug: maxScene > 0 ? lastSlug : "opening",
      transcript,
      precis: "",
      sessionNumber: maxSession + 1, // next session
    };
  }, []);

  // --- Start engine for a campaign ---
  const startEngine = useCallback(async (config: CampaignConfig, campaignRoot: string, isResume = false) => {
    const gs = buildGameState(config, campaignRoot);
    gameStateRef.current = gs;

    // On resume, detect scene/session state from disk; otherwise start fresh
    const scene: SceneState = isResume
      ? await detectSceneState(campaignRoot)
      : { sceneNumber: 1, slug: "opening", transcript: [], precis: "", sessionNumber: 1 };

    const sessionState: DMSessionState = {};
    const client = new Anthropic();
    clientRef.current = client;

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

    // Create gitIO if git recovery is enabled
    const gitIO = config.recovery.enable_git ? createGitIO() : undefined;

    // Update shutdown context
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
      // Load session recap + campaign log into DM's prefix context
      const recap = await engine.resumeSession();

      setNarrativeLines([`Welcome back to ${config.name}.`, ""]);
      if (recap) {
        setNarrativeLines((prev) => [...prev, "Previously...", "", recap, ""]);
      }
      setPhase("playing");

      // Send a resume-specific prompt to the DM
      const activePlayer = getActivePlayer(gs);
      const resumeParts = ["[Session resumes. Continue the narrative where we left off."];
      if (config.premise) resumeParts.push(`Campaign premise: ${config.premise}`);
      const pc = config.players[0];
      if (pc) resumeParts.push(`The player character is ${pc.character}.`);
      if (recap) resumeParts.push(`Last session recap: ${recap}`);
      resumeParts.push("Pick up naturally from the last scene — do NOT restart or re-introduce the setting.");
      await engine.processInput(activePlayer.characterName, resumeParts.join(" ") + "]");
    } else {
      setNarrativeLines([`Welcome to ${config.name}.`, "", "The story begins..."]);
      setPhase("playing");

      // Send opening prompt to DM with campaign context
      const activePlayer = getActivePlayer(gs);
      const openingParts = ["[Session begins. Set the scene."];
      if (config.premise) openingParts.push(`Campaign premise: ${config.premise}`);
      const pc = config.players[0];
      if (pc) openingParts.push(`The player character is ${pc.character}.`);
      await engine.processInput(activePlayer.characterName, openingParts.join(" ") + "]");
    }
  }, [buildGameState, buildCallbacks, shutdownRef, detectSceneState]);

  // --- Setup callback: presents choices to user via modal ---
  const setupCallback = useCallback(async (step: SetupStep): Promise<number | string> => {
    return new Promise<number | string>((resolve) => {
      setSetupPrompt(step);
      setSetupChoiceIndex(step.defaultIndex);
      setupResolveRef.current = resolve;
    });
  }, []);

  // --- Finalize setup result into a running campaign ---
  const finalizeSetup = useCallback(async (result: SetupResult) => {
    setPhase("building");
    setNarrativeLines(["Building your world..."]);

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

  // --- Shared helpers for conversational setup ---
  const setupStreamDelta = useCallback((delta: string) => {
    setSetupConvoLines((prev) => {
      const lines = [...prev];
      if (lines.length === 0) lines.push(delta);
      else lines[lines.length - 1] += delta;
      const last = lines[lines.length - 1];
      if (last.includes("\n")) {
        const parts = last.split("\n");
        lines[lines.length - 1] = parts[0];
        for (let i = 1; i < parts.length; i++) {
          lines.push(parts[i]);
        }
      }
      return lines;
    });
  }, []);

  const handleSetupTurnResult = useCallback(async (result: { finalized?: SetupResult; pendingChoices?: { prompt: string; choices: string[] }; usage: UsageStats }) => {
    setSetupConvoBusy(false);
    setSetupConvoLines((prev) => [...prev, ""]);

    if (result.pendingChoices) {
      // Show choice modal for the player
      setChoiceIndex(0);
      setActiveModal({
        kind: "choice",
        prompt: result.pendingChoices.prompt,
        choices: result.pendingChoices.choices,
      });
      return;
    }

    if (result.finalized) {
      costTracker.current.record(result.usage, getModel("medium"));
      setupConvoRef.current = null;
      await finalizeSetup(result.finalized);
    }
  }, [finalizeSetup, setActiveModal]);

  // --- Run setup flow ---
  const runSetup = useCallback(async (mode: "fast" | "full") => {
    setPhase("setup");

    if (mode === "full") {
      const client = new Anthropic();
      const convo = createSetupConversation(client);
      setupConvoRef.current = convo;
      setSetupConvoLines([]);
      setSetupConvoInput("");
      setSetupConvoBusy(true);

      try {
        const result = await convo.start(setupStreamDelta);
        await handleSetupTurnResult(result);
      } catch (e) {
        setSetupConvoBusy(false);
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setPhase("main_menu");
      }
      return;
    }

    // Fast path: step-by-step choices
    const result = await fastPathSetup(setupCallback);
    setSetupPrompt(null);
    await finalizeSetup(result);
  }, [setupCallback, finalizeSetup, setupStreamDelta, handleSetupTurnResult]);

  // --- Send a message in conversational setup ---
  const sendSetupMessage = useCallback(async (text: string) => {
    const convo = setupConvoRef.current;
    if (!convo) return;

    setSetupConvoLines((prev) => [...prev, `> ${text}`, ""]);
    setSetupConvoBusy(true);

    try {
      const result = await convo.send(text, setupStreamDelta);
      await handleSetupTurnResult(result);
    } catch (e) {
      setSetupConvoBusy(false);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("main_menu");
    }
  }, [setupStreamDelta, handleSetupTurnResult]);

  // --- Resolve a choice modal during conversational setup ---
  const resolveSetupChoice = useCallback(async (selectedText: string) => {
    const convo = setupConvoRef.current;
    if (!convo) return;

    setActiveModal(null);
    setChoiceIndex(0);
    setSetupConvoLines((prev) => [...prev, `> ${selectedText}`, ""]);
    setSetupConvoBusy(true);

    try {
      const result = await convo.resolveChoice(selectedText, setupStreamDelta);
      await handleSetupTurnResult(result);
    } catch (e) {
      setSetupConvoBusy(false);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("main_menu");
    }
  }, [setActiveModal, setupStreamDelta, handleSetupTurnResult]);

  // --- Resume a campaign ---
  const resumeCampaign = useCallback(async (entry: CampaignEntry) => {
    setPhase("building");
    setNarrativeLines(["Loading campaign..."]);

    try {
      const configRaw = await readFile(join(entry.path, "config.json"), "utf-8");
      const config: CampaignConfig = JSON.parse(configRaw);
      await startEngine(config, entry.path, true);
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
      // Campaign select sub-menu
      if (menuOpen && campaigns.length > 0) {
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

      const mainMenuItems = campaigns.length > 0
        ? ["New Campaign", "Continue Campaign", "Just Jump In", "Quit"]
        : ["New Campaign", "Just Jump In", "Quit"];

      if (key.upArrow) {
        setMainMenuIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setMainMenuIndex((i) => Math.min(mainMenuItems.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const selected = mainMenuItems[mainMenuIndex];
        if (selected === "New Campaign") {
          runSetup("full");
        } else if (selected === "Continue Campaign") {
          setMenuOpen(true);
          setCampaignSelectIndex(0);
        } else if (selected === "Just Jump In") {
          runSetup("fast");
        } else if (selected === "Quit") {
          process.exit(0);
        }
        return;
      }
      if (input === "q" || input === "Q") {
        process.exit(0);
      }
      return;
    }

    // --- Setup: conversational mode ---
    if (phase === "setup" && setupConvoRef.current) {
      // Choice modal active during setup
      const modal = activeModalRef.current;
      if (modal && modal.kind === "choice") {
        if (key.upArrow) {
          setChoiceIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setChoiceIndex((i) => Math.min(modal.choices.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const chosen = modal.choices[choiceIndex];
          resolveSetupChoice(chosen);
          return;
        }
        if (key.escape) {
          // Dismiss modal — treat as if they want to type instead
          setActiveModal(null);
          setChoiceIndex(0);
          return;
        }
        return;
      }

      if (setupConvoBusy) return; // Block input while agent is responding

      if (key.return && setupConvoInput.trim()) {
        const text = setupConvoInput.trim();
        setSetupConvoInput("");
        sendSetupMessage(text);
        return;
      }
      if (key.escape) {
        // Cancel setup, return to main menu
        setupConvoRef.current = null;
        setSetupConvoLines([]);
        setSetupConvoInput("");
        setActiveModal(null);
        setPhase("main_menu");
        return;
      }
      if (key.backspace || key.delete) {
        setSetupConvoInput((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.return) {
        setSetupConvoInput((v) => v + input);
      }
      return;
    }

    // --- Setup: step-by-step choosing (fast path) ---
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
      // Modal input takes priority over everything except ESC for menu
      const modal = activeModalRef.current;

      // Non-choice modals: any key dismisses
      if (modal && (modal.kind === "dice" || modal.kind === "character_sheet" || modal.kind === "recap")) {
        setActiveModal(null);
        return;
      }

      // Choice modal: arrow keys to navigate, Enter to select, ESC dismisses
      if (modal && modal.kind === "choice") {
        if (key.escape) {
          setActiveModal(null);
          setChoiceIndex(0);
          return;
        }
        if (key.upArrow) {
          setChoiceIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setChoiceIndex((i) => Math.min(modal.choices.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const chosen = modal.choices[choiceIndex];
          setActiveModal(null);
          setChoiceIndex(0);
          // Send chosen text as player input
          if (engineRef.current && gameStateRef.current) {
            const active = getActivePlayer(gameStateRef.current);
            setNarrativeLines((prev) => [...prev, "", `> ${active.characterName}: ${chosen}`, ""]);
            engineRef.current.processInput(active.characterName, chosen);
          }
        }
        return;
      }

      // OOC active: block game input, ESC cancels
      if (oocActive) {
        if (key.escape) {
          setOocActive(false);
          setVariant("exploration");
        }
        return;
      }

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
          } else if (item === "Character Sheet") {
            setMenuOpen(false);
            const gs = gameStateRef.current;
            if (gs) {
              const active = getActivePlayer(gs);
              const path = campaignPaths(gs.campaignRoot).character(active.characterName);
              fileIO.current.readFile(path).then((content) => {
                setActiveModal({ kind: "character_sheet", content });
              }).catch(() => {
                setActiveModal({ kind: "character_sheet", content: `[Could not load character sheet for ${active.characterName}]` });
              });
            }
          } else if (item === "OOC Mode") {
            setMenuOpen(false);
            setOocActive(true);
            setVariant("ooc");
            setNarrativeLines((prev) => [...prev, "[OOC Mode]"]);
            // Single-shot OOC: run subagent then return
            if (clientRef.current && gameStateRef.current) {
              const gs = gameStateRef.current;
              enterOOC(clientRef.current, "", {
                campaignName: gs.config.name,
                previousVariant: variant,
              }, (delta) => {
                setNarrativeLines((prev) => {
                  const lines = [...prev];
                  if (lines.length === 0) lines.push(delta);
                  else lines[lines.length - 1] += delta;
                  return lines;
                });
              }).then((result) => {
                setOocActive(false);
                setVariant(result.snapshot.previousVariant as StyleVariant);
                setNarrativeLines((prev) => [...prev, ""]);
                costTracker.current.record(result.usage, getModel("medium"));
              }).catch(() => {
                setOocActive(false);
                setVariant("exploration");
              });
            }
          }
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
      gitIO: shutdownRef?.current?.gitIO,
    });

    process.exit(0);
  }, [shutdownRef]);

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

    const mainMenuItems = campaigns.length > 0
      ? ["New Campaign", "Continue Campaign", "Just Jump In", "Quit"]
      : ["New Campaign", "Just Jump In", "Quit"];
    const mainMenuDescriptions: Record<string, string> = {
      "New Campaign": "Full guided setup",
      "Continue Campaign": `${campaigns.length} saved`,
      "Just Jump In": "Quick start with defaults",
      "Quit": "",
    };

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>TUI-RPG</Text>
        <Text> </Text>
        {mainMenuItems.map((item, i) => (
          <Text key={item}>
            {i === mainMenuIndex ? ">" : " "} {item}
            {mainMenuDescriptions[item] ? <Text dimColor> — {mainMenuDescriptions[item]}</Text> : null}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>Arrow keys to select, Enter to confirm.</Text>
        {errorMsg && <Text color="red">{errorMsg}</Text>}
      </Box>
    );
  }

  // Setup flow: conversational
  if (phase === "setup" && setupConvoRef.current) {
    const setupHasModal = activeModal?.kind === "choice";
    const setupModalHeight = setupHasModal && activeModal
      ? activeModal.choices.length + 5 + 2  // choices + prompt/blanks/instructions + borders
      : 0;
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows: rows - setupModalHeight }}
          style={style}
          variant="exploration"
          narrativeLines={setupConvoLines}
          modelineText="Campaign Setup"
          inputValue={setupConvoInput}
          activeCharacterName="You"
          players={[{ name: "Player", isAI: false }]}
          activePlayerIndex={0}
          campaignName="New Campaign"
          resources={[]}
          turnHolder="You"
          engineState={setupConvoBusy ? "dm_thinking" : null}
        />
        {setupHasModal && activeModal && (
          <ChoiceModal
            variant={style.variants["exploration"]}
            width={cols}
            prompt={activeModal.prompt}
            choices={activeModal.choices}
            selectedIndex={choiceIndex}
          />
        )}
      </Box>
    );
  }

  // Setup flow: step-by-step (fast path)
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
  // Compute actual modal height (content lines + 2 border rows)
  const modalHeight = (() => {
    if (!activeModal) return 0;
    switch (activeModal.kind) {
      case "choice":
        // prompt + empty + N choices + empty + instructions + 2 borders
        return activeModal.choices.length + 5 + 2;
      case "dice":
        // reason? + expression + dice + kept? + total + blanks + 2 borders
        return 8 + 2;
      case "character_sheet":
        // content lines + 2 borders, capped at half the screen
        return Math.min(activeModal.content.split("\n").length + 2, Math.floor(rows / 2));
      case "recap":
        return Math.min(activeModal.lines.length + 2, Math.floor(rows / 2));
    }
  })();
  const layoutRows = menuOpen ? rows - MENU_ITEMS.length - 4 : rows - modalHeight;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Layout
        dimensions={{ columns: cols, rows: layoutRows }}
        style={style}
        variant={variant}
        narrativeLines={narrativeLines}
        modelineText={modelineOverride ?? `${costTracker.current.formatTerse()} | ${campaignName}`}
        inputValue={inputValue}
        activeCharacterName={activeChar}
        players={players}
        activePlayerIndex={activePlayerIndex}
        campaignName={campaignName}
        resources={resources}
        turnHolder={activeChar}
        engineState={engineState}
        dmBackground="#1a0033"
        quoteColor="#ffffff"
      />
      {menuOpen && (
        <GameMenu
          variant={style.variants[variant]}
          width={cols}
          selectedIndex={menuIndex}
        />
      )}
      {!menuOpen && activeModal?.kind === "choice" && (
        <ChoiceModal
          variant={style.variants[variant]}
          width={cols}
          prompt={activeModal.prompt}
          choices={activeModal.choices}
          selectedIndex={choiceIndex}
        />
      )}
      {!menuOpen && activeModal?.kind === "dice" && (
        <DiceRollModal
          variant={style.variants[variant]}
          width={cols}
          expression={activeModal.expression}
          rolls={activeModal.rolls}
          kept={activeModal.kept}
          total={activeModal.total}
          reason={activeModal.reason}
        />
      )}
      {!menuOpen && activeModal?.kind === "character_sheet" && (
        <CharacterSheetModal
          variant={style.variants[variant]}
          width={cols}
          content={activeModal.content}
        />
      )}
      {!menuOpen && activeModal?.kind === "recap" && (
        <SessionRecapModal
          variant={style.variants[variant]}
          width={cols}
          lines={activeModal.lines}
        />
      )}
    </Box>
  );
}
