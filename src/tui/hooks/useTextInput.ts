import { useCallback } from "react";
import type { Key as InkKey } from "ink";

export interface UseTextInputOptions {
  value: string;
  onChange: React.Dispatch<React.SetStateAction<string>>;
  disabled?: boolean;
}

export interface TextInputActions {
  /** Handle a keypress. Returns true if the key was consumed (backspace or char append). */
  handleKey(input: string, key: InkKey): boolean;
  /** Clear the input value. */
  clear(): void;
}

/**
 * Shared text-editing logic: backspace + character append.
 * Return/submit handling stays with the caller (each site has unique submit logic).
 */
export function useTextInput({ onChange, disabled }: UseTextInputOptions): TextInputActions {
  const handleKey = useCallback((input: string, key: InkKey): boolean => {
    if (disabled) return false;

    if (key.backspace || key.delete) {
      onChange((v) => v.slice(0, -1));
      return true;
    }
    if (input && !key.ctrl && !key.meta && !key.return) {
      onChange((v) => v + input);
      return true;
    }
    return false;
  }, [disabled, onChange]);

  const clear = useCallback(() => {
    onChange("");
  }, [onChange]);

  return { handleKey, clear };
}
