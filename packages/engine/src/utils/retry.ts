/**
 * Shared retry utilities for API calls.
 * Used by provider adapters and any code that needs exponential backoff.
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 12_000;

export function retryDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

/** Status 0 is synthetic — used for network-level errors (no HTTP status). */
export const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503, 529]);

/** Patterns that indicate a network-level (not application-level) failure. */
const NETWORK_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "fetch failed",
  "socket hang up",
  "network error",
  "connection error",
  "Failed to fetch",
  "EPIPE",
];

export function extractStatus(e: unknown): number | null {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status: number }).status;
    if (typeof status === "number") return status;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("overloaded")) return 529;
  const lower = msg.toLowerCase();
  for (const pat of NETWORK_ERROR_PATTERNS) {
    if (lower.includes(pat.toLowerCase())) return 0;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
