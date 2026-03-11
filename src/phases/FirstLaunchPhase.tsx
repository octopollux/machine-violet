import React, { useState } from "react";
import { useInput, Text, Box } from "ink";
import { validateApiKeyFormat } from "../config/first-launch.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";

export interface FirstLaunchPhaseProps {
  /** Pre-filled API key (e.g. from env) */
  initialApiKey: string;
  /** Error from parent (e.g. config write failure) */
  externalError?: string | null;
  /** Called with validated API key on Enter */
  onComplete: (apiKey: string) => void;
}

export function FirstLaunchPhase({ initialApiKey, externalError, onComplete }: FirstLaunchPhaseProps) {
  const [apiKeyInput, setApiKeyInput] = useState(initialApiKey);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const displayError = apiKeyError || externalError || null;
  const { handleKey } = useTextInput({ value: apiKeyInput, onChange: setApiKeyInput });

  useInput((input, key) => {
    if (key.return) {
      const trimmed = apiKeyInput.trim();
      if (validateApiKeyFormat(trimmed)) {
        setApiKeyError(null);
        onComplete(trimmed);
      } else {
        setApiKeyError("Invalid key format (expected sk-ant-...)");
      }
      return;
    }
    handleKey(input, key);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Machine Violet — First Time Setup</Text>
      <Text> </Text>
      <Text>Paste your Anthropic API key:</Text>
      <Text> </Text>
      <Text>{">"} {apiKeyInput.length > 0 ? apiKeyInput.slice(0, 10) + "..." + apiKeyInput.slice(-4) : "_"}</Text>
      {displayError && <Text color="red">{displayError}</Text>}
      <Text> </Text>
      <Text dimColor>Press Enter to confirm.</Text>
    </Box>
  );
}
