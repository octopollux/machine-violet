import React, { useState, useRef, useCallback } from "react";
import { useInput, Text, Box } from "ink";
import { createClient } from "../config/client.js";
import type { NarrativeLine } from "../types/tui.js";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { appendDelta } from "../tui/narrative-helpers.js";
import { Layout } from "../tui/layout.js";
import { ChoiceOverlay, DESCRIPTION_ROWS } from "../tui/modals/index.js";
import type { NarrativeAreaHandle } from "../tui/components/index.js";
import { scrollAmount, TerminalTooSmall, buildModelineDisplay, splitModeline } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS, getViewportTier, getVisibleElements, choiceRowBudget } from "../tui/responsive.js";
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

    const client = createClient();
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
      // Choice modal handles its own input
      if (activeModal) return;

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
          activeCharacterName="Player"
          inputIsDisabled
          players={[{ name: "Player", isAI: false }]}
          activePlayerIndex={0}
          campaignName="New Campaign"
          resources={[]}
          turnHolder="Player"
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

    // Compute dynamic choice row budget for this tier
    const visibleElements = getVisibleElements(getViewportTier({ columns: cols, rows }));
    const mlLineCount = splitModeline(buildModelineDisplay("Campaign Setup"), cols).length;
    const setupMaxChoiceRows = choiceRowBudget(visibleElements, mlLineCount, hasDescriptions, DESCRIPTION_ROWS);

    // Build overlay for choice modal (replaces Player Pane content)
    const choiceOverlay = setupHasModal && activeModal ? (
      <ChoiceOverlay
        width={cols - 4}
        prompt={activeModal.prompt}
        choices={activeModal.choices}
        descriptions={activeModal.descriptions}
        accentColor={theme.keyColor}
        maxChoiceRows={setupMaxChoiceRows}
        initialIndex={activeModal.choices.length < 5 ? activeModal.choices.length : 0}
        onSelect={(choice) => resolveSetupChoice(choice)}
        onDismiss={() => setActiveModal(null)}
        onNarrativeScroll={(dir) => {
          const step = scrollAmount(rows);
          narrativeRef.current?.scrollBy(dir < 0 ? -step : step);
        }}
      />
    ) : undefined;

    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Layout
          dimensions={{ columns: cols, rows }}
          theme={theme}
          narrativeLines={setupConvoLines}
          modelineText="Campaign Setup"
          activeCharacterName="Player"
          inputIsDisabled={textInputDisabled}
          inputResetKey={resetKey}
          onInputSubmit={handleSetupSubmit}
          players={[{ name: "Player", isAI: false }]}
          activePlayerIndex={0}
          campaignName="New Campaign"
          resources={[]}
          turnHolder="Player"
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
