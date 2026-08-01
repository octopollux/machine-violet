import { coerceResourceKeys } from "@machine-violet/shared";

/**
 * Format resource key/value maps into the strings rendered in the top frame.
 *
 * The display-key input admits legacy bare strings even though current wire
 * state uses arrays; coerceResourceKeys keeps old campaign data safe.
 */
export function formatResources(
  displayResources: Record<string, string[] | string>,
  resourceValues: Record<string, Record<string, string>>,
): string[] {
  const result: string[] = [];
  for (const [character, keys] of Object.entries(displayResources)) {
    const values = resourceValues[character] ?? {};
    for (const key of coerceResourceKeys(keys)) {
      const value = values[key];
      result.push(value ? `${key} ${value}` : key);
    }
  }
  return result;
}
