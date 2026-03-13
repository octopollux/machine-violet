import React, { useState, useRef, useCallback } from "react";
import { useInput, Text, Box } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import type { NarrativeLine } from "../types/tui.js";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { appendDelta } from "../tui/narrative-helpers.js";
import { Layout } from "../tui/layout.js";
import { ChoiceOverlay, DESCRIPTION_ROWS } from "../tui/modals/index.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import type { SetupResult } from "../agents/setup-agent.js";
import { createSetupConversation } from "../agents/subagents/setup-conversation.js";
import type { SetupConversation } from "../agents/subagents/setup-conversation.js";
import type { UsageStats } from "../agents/agent-loop.js";
import { CostTracker } from "../context/cost-tracker.js";

interface ActiveChoiceModal { kind: "choice"; prompt: string; choices: string[]; descriptions?: string[] }

export interface SetupPhaseProps {
  theme: ResolvedTheme;
  costTracker: React.RefObject<CostTracker>;
  onComplete: (result: SetupResult) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

export function SetupPhase({ theme, costTracker, onComplete, onCancel, onError }: SetupPhaseProps) {
  const { columns: cols, rows } = useTerminalSize();
  const tooSmall = cols < MIN_COLUMNS || rows < MIN_ROWS;

  const narrativeRef = useRef<NarrativeAreaHandle>(null);

  // Conversational setup state
  const setupConvoRef = useRef<SetupConversation | null>(null);
  const [setupConvoLines, setSetupConvoLines] = useState<NarrativeLine[]>([]);
  const [setupConvoBusy, setSetupConvoBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const clearInput = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);

  // Choice modal state
  const [activeModal, setActiveModal] = useState<ActiveChoiceModal | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);

  // Custom input state for "Enter your own" in choice modals
  const [customInputActive, setCustomInputActive] = useState(false);
  const [customInputResetKey, setCustomInputResetKey] = useState(0);

  // Gate: hold finalized result until player presses ENTER
  const [pendingResult, setPendingResult] = useState<SetupResult | null>(null);

  // Track whether we've started (to avoid double-starting in strict mode)
  const startedRef = useRef(false);

  // --- Streaming delta handler ---
  const setupStreamDelta = useCallback((delta: string) => {
    setSetupConvoLines((prev) => appendDelta(prev, delta, "dm"));
  }, []);

  // --- Handle turn result from conversation ---
  const handleSetupTurnResult = useCallback(async (result: { finalized?: SetupResult; pendingChoices?: { prompt: string; choices: string[]; descriptions?: string[] }; usage: UsageStats }) => {
    setSetupConvoBusy(false);
    setSetupConvoLines((prev) => [...prev, { kind: "dm", text: "" }]);

    if (result.pendingChoices) {
      // When fewer than 5 options, default focus to "Enter your own" so the user can freely type
      const customIndex = result.pendingChoices.choices.length;
      setChoiceIndex(customIndex < 5 ? customIndex : 0);
      setCustomInputActive(customIndex < 5);

      setActiveModal({
        kind: "choice",
        prompt: result.pendingChoices.prompt,
        choices: result.pendingChoices.choices,
        descriptions: result.pendingChoices.descriptions,
      });
      return;
    }

    if (result.finalized) {
      costTracker.current?.record(result.usage, "medium");
      setupConvoRef.current = null;
      setPendingResult(result.finalized);
      setSetupConvoLines((prev) => [...prev, { kind: "dm", text: "<center><b>[Press ENTER to begin your adventure]</b></center>" }]);
    }
  }, [costTracker]);

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
    setCustomInputActive(false);
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

  // --- Handle custom input submit from "Enter your own" ---
  const handleCustomInputSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    const text = value.trim();
    setCustomInputActive(false);
    setCustomInputResetKey((k) => k + 1);
    resolveSetupChoice(text);
  }, [resolveSetupChoice]);

  // --- Start setup (once) ---
  const startSetup = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

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
  }, [clearInput, setupStreamDelta, handleSetupTurnResult, onError, onCancel]);

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

  // --- Input handling (modals — TextInput handles text editing) ---
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
        const totalOptions = activeModal.choices.length + 1; // +1 for "Enter your own"

        if (customInputActive) {
          if (key.escape) {
            setCustomInputActive(false);
            return;
          }
          if (key.upArrow) {
            setCustomInputActive(false);
            setCustomInputResetKey((k) => k + 1);
            setChoiceIndex(activeModal.choices.length - 1);
            return;
          }
          if (key.pageUp || key.pageDown) {
            const step = scrollAmount(rows);
            narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
            return;
          }
          return;
        }

        if (key.upArrow) {
          setChoiceIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setChoiceIndex((i) => {
            const next = Math.min(totalOptions - 1, i + 1);
            if (next === activeModal.choices.length) {
              setCustomInputActive(true);
            }
            return next;
          });
          return;
        }
        if (key.return) {
          if (choiceIndex === activeModal.choices.length) {
            setCustomInputActive(true);
            return;
          }
          const chosen = activeModal.choices[choiceIndex];
          resolveSetupChoice(chosen);
          return;
        }
        if (key.escape) {
          setActiveModal(null);
          setChoiceIndex(0);
          setCustomInputActive(false);
          return;
        }
        if (key.pageUp || key.pageDown) {
          const step = scrollAmount(rows);
          narrativeRef.current?.scrollBy(key.pageUp ? -step : step);
        }
        if (_input === "+" || _input === "-") {
          const step = scrollAmount(rows);
          narrativeRef.current?.scrollBy(_input === "-" ? -step : step);
        }
        return;
      }

      if (key.escape) {
        setupConvoRef.current = null;
        setSetupConvoLines([]);
        clearInput();
        setActiveModal(null);
        setCustomInputActive(false);
        onCancel();
        return;
      }
      return;
    }
  });

  // --- Render: terminal too small ---
  if (tooSmall) {
    return <TerminalTooSmall columns={cols} rows={rows} />;
  }

  // --- Render: awaiting ENTER after setup farewell ---
  if (pendingResult) {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows }}
          theme={theme}
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
    const hasDescriptions = setupHasModal && activeModal?.descriptions != null && activeModal.descriptions.length > 0;
    const paneExtraHeight = hasDescriptions ? DESCRIPTION_ROWS : 0;

    // Build overlay for choice modal (replaces Player Pane content)
    const choiceOverlay = setupHasModal && activeModal ? (
      <ChoiceOverlay
        width={cols - 4}
        prompt={activeModal.prompt}
        choices={activeModal.choices}
        descriptions={activeModal.descriptions}
        selectedIndex={choiceIndex}
        showCustomInput
        customInputActive={customInputActive}
        customInputResetKey={customInputResetKey}
        onCustomInputSubmit={handleCustomInputSubmit}
      />
    ) : undefined;

    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows }}
          theme={theme}
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
          narrativeRef={narrativeRef}
          hideInputLine={setupHasModal}
          playerPaneOverlay={choiceOverlay}
          playerPaneExtraHeight={paneExtraHeight}
        />
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
