import React, { useState, useRef, useCallback } from "react";
import { useInput, useStdout, Text, Box } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import type { FrameStyle, NarrativeLine } from "../types/tui.js";
import { appendDelta } from "../tui/narrative-helpers.js";
import { Layout } from "../tui/layout.js";
import { ChoiceModal } from "../tui/modals/index.js";
import type { SetupStep, SetupResult } from "../agents/setup-agent.js";
import { fastPathSetup } from "../agents/setup-agent.js";
import { createSetupConversation } from "../agents/subagents/setup-conversation.js";
import type { SetupConversation } from "../agents/subagents/setup-conversation.js";
import type { UsageStats } from "../agents/agent-loop.js";
import { CostTracker } from "../context/cost-tracker.js";
import { getModel } from "../config/models.js";

type ActiveChoiceModal = { kind: "choice"; prompt: string; choices: string[] };

export interface SetupPhaseProps {
  mode: "fast" | "full";
  style: FrameStyle;
  costTracker: React.RefObject<CostTracker>;
  onComplete: (result: SetupResult) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

export function SetupPhase({ mode, style, costTracker, onComplete, onCancel, onError }: SetupPhaseProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 40;

  // Conversational setup state
  const setupConvoRef = useRef<SetupConversation | null>(null);
  const [setupConvoLines, setSetupConvoLines] = useState<NarrativeLine[]>([]);
  const [setupConvoBusy, setSetupConvoBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const clearInput = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);

  // Choice modal state (shared by both modes)
  const [activeModal, setActiveModal] = useState<ActiveChoiceModal | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);

  // Gate: hold finalized result until player presses ENTER
  const [pendingResult, setPendingResult] = useState<SetupResult | null>(null);

  // Fast-path setup state
  const [setupPrompt, setSetupPrompt] = useState<SetupStep | null>(null);
  const setupResolveRef = useRef<((idx: number | string) => void) | null>(null);
  const [setupChoiceIndex, setSetupChoiceIndex] = useState(0);

  // Track whether we've started (to avoid double-starting in strict mode)
  const startedRef = useRef(false);

  // --- Streaming delta handler ---
  const setupStreamDelta = useCallback((delta: string) => {
    setSetupConvoLines((prev) => appendDelta(prev, delta, "dm"));
  }, []);

  // --- Handle turn result from conversation ---
  const handleSetupTurnResult = useCallback(async (result: { finalized?: SetupResult; pendingChoices?: { prompt: string; choices: string[] }; usage: UsageStats }) => {
    setSetupConvoBusy(false);
    setSetupConvoLines((prev) => [...prev, { kind: "dm", text: "" }]);

    if (result.pendingChoices) {
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
      setPendingResult(result.finalized);
      setSetupConvoLines((prev) => [...prev, { kind: "dm", text: "" }, { kind: "dm", text: "<center><b>[Press ENTER to begin your adventure]</b></center>" }]);
    }
  }, [costTracker, onComplete, setActiveModal]);

  // --- Send message in conversational setup ---
  const sendSetupMessage = useCallback(async (text: string) => {
    const convo = setupConvoRef.current;
    if (!convo) return;

    setSetupConvoLines((prev) => [...prev, { kind: "player", text: `> ${text}` }, { kind: "dm", text: "" }, { kind: "dm", text: "" }]);
    setSetupConvoBusy(true);

    try {
      const result = await convo.send(text, setupStreamDelta);
      await handleSetupTurnResult(result);
    } catch (e) {
      setSetupConvoBusy(false);
      onError(e instanceof Error ? e.message : String(e));
      onCancel();
    }
  }, [setupStreamDelta, handleSetupTurnResult, onError, onCancel]);

  // --- Resolve choice modal during conversational setup ---
  const resolveSetupChoice = useCallback(async (selectedText: string) => {
    const convo = setupConvoRef.current;
    if (!convo) return;

    setActiveModal(null);
    setChoiceIndex(0);
    setSetupConvoLines((prev) => [...prev, { kind: "player", text: `> ${selectedText}` }, { kind: "dm", text: "" }, { kind: "dm", text: "" }]);
    setSetupConvoBusy(true);

    try {
      const result = await convo.resolveChoice(selectedText, setupStreamDelta);
      await handleSetupTurnResult(result);
    } catch (e) {
      setSetupConvoBusy(false);
      onError(e instanceof Error ? e.message : String(e));
      onCancel();
    }
  }, [setActiveModal, setupStreamDelta, handleSetupTurnResult, onError, onCancel]);

  // --- Start setup (once) ---
  const startSetup = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (mode === "full") {
      const client = new Anthropic();
      const convo = createSetupConversation(client);
      setupConvoRef.current = convo;
      setSetupConvoLines([]);
      clearInput();
      setSetupConvoBusy(true);

      try {
        const result = await convo.start(setupStreamDelta);
        await handleSetupTurnResult(result);
      } catch (e) {
        setSetupConvoBusy(false);
        onError(e instanceof Error ? e.message : String(e));
        onCancel();
      }
    } else {
      // Fast path: step-by-step choices
      const setupCallback = async (step: SetupStep): Promise<number | string> => {
        return new Promise<number | string>((resolve) => {
          setSetupPrompt(step);
          setSetupChoiceIndex(step.defaultIndex);
          setupResolveRef.current = resolve;
        });
      };
      const result = await fastPathSetup(setupCallback);
      setSetupPrompt(null);
      onComplete(result);
    }
  }, [mode, clearInput, setupStreamDelta, handleSetupTurnResult, onComplete, onError, onCancel]);

  // Start on first render
  React.useEffect(() => {
    startSetup();
  }, [startSetup]);

  // Whether TextInput should be disabled
  const textInputDisabled = !!pendingResult || !!activeModal || setupConvoBusy || !setupConvoRef.current;

  // --- Submit handler for TextInput ---
  const handleSetupSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();
    clearInput();
    sendSetupMessage(text);
  }, [clearInput, sendSetupMessage]);

  // --- Input handling (modals, menus — TextInput handles text editing) ---
  useInput((_input, key) => {
    // Waiting for ENTER after setup farewell
    if (pendingResult) {
      if (key.return) {
        onComplete(pendingResult);
      }
      return;
    }

    // Conversational mode
    if (setupConvoRef.current) {
      // Choice modal active during setup
      if (activeModal && activeModal.kind === "choice") {
        if (key.upArrow) {
          setChoiceIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setChoiceIndex((i) => Math.min(activeModal!.choices.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const chosen = activeModal.choices[choiceIndex];
          resolveSetupChoice(chosen);
          return;
        }
        if (key.escape) {
          setActiveModal(null);
          setChoiceIndex(0);
          return;
        }
        return;
      }

      if (key.escape) {
        setupConvoRef.current = null;
        setSetupConvoLines([]);
        clearInput();
        setActiveModal(null);
        onCancel();
        return;
      }
      return;
    }

    // Fast-path step-by-step choosing
    if (setupPrompt && setupResolveRef.current) {
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
    }
  });

  // --- Render: awaiting ENTER after setup farewell ---
  if (pendingResult) {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows }}
          style={style}
          variant="exploration"
          narrativeLines={setupConvoLines}
          modelineText="Campaign Setup"
          activeCharacterName="You"
          inputIsDisabled
          players={[{ name: "Player", isAI: false }]}
          activePlayerIndex={0}
          campaignName="New Campaign"
          resources={[]}
          turnHolder="You"
          engineState={null}
        />
      </Box>
    );
  }

  // --- Render: conversational mode ---
  if (setupConvoRef.current) {
    const setupHasModal = activeModal?.kind === "choice";
    const setupModalHeight = setupHasModal && activeModal
      ? activeModal.choices.length + 5 + 2
      : 0;
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows: rows - setupModalHeight }}
          style={style}
          variant="exploration"
          narrativeLines={setupConvoLines}
          modelineText="Campaign Setup"
          activeCharacterName="You"
          inputIsDisabled={textInputDisabled}
          inputResetKey={resetKey}
          onInputSubmit={handleSetupSubmit}
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

  // --- Render: fast-path step-by-step ---
  if (setupPrompt) {
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

  // Fallback while starting
  return (
    <Box flexDirection="column" padding={1}>
      <Text>Starting setup...</Text>
    </Box>
  );
}
