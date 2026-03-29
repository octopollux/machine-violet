/**
 * API key format validation for the client.
 */

/** Validate an API key format (starts with sk-ant-). */
export function validateApiKeyFormat(key: string): boolean {
  return /^sk-ant-[a-zA-Z0-9_-]{20,}$/.test(key.trim());
}
