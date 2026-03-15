/**
 * API key health checking.
 *
 * Validates a key by making a minimal Haiku API call (max_tokens: 1).
 * Extracts rate-limit metadata from response headers when available.
 */
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyHealthStatus = "valid" | "invalid" | "error" | "rate_limited" | "checking";

export interface RateLimitInfo {
  requestsLimit?: number;
  requestsRemaining?: number;
  tokensLimit?: number;
  tokensRemaining?: number;
}

export interface KeyHealthResult {
  status: KeyHealthStatus;
  message: string;
  rateLimits?: RateLimitInfo;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

const HEALTH_CHECK_MODEL = "claude-haiku-4-5-20251001";

/**
 * Validate an API key by making a minimal API call.
 * Uses Haiku with max_tokens=1 — costs a fraction of a cent.
 */
export async function checkKeyHealth(apiKey: string): Promise<KeyHealthResult> {
  const client = new Anthropic({ apiKey });
  const now = new Date().toISOString();

  try {
    const raw = await client.messages.create({
      model: HEALTH_CHECK_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }).withResponse();

    const rateLimits = extractRateLimits(raw.response.headers);

    return {
      status: "valid",
      message: "Key is valid",
      rateLimits,
      checkedAt: now,
    };
  } catch (e: unknown) {
    if (e instanceof Anthropic.AuthenticationError) {
      return { status: "invalid", message: "Invalid API key", checkedAt: now };
    }
    if (e instanceof Anthropic.PermissionDeniedError) {
      return { status: "invalid", message: "Permission denied", checkedAt: now };
    }
    if (e instanceof Anthropic.RateLimitError) {
      return {
        status: "rate_limited",
        message: "Rate limited (key is valid)",
        checkedAt: now,
      };
    }
    // Overloaded = key works but API is busy
    if (e instanceof Anthropic.APIError && e.status === 529) {
      return {
        status: "valid",
        message: "API overloaded (key is valid)",
        checkedAt: now,
      };
    }
    return {
      status: "error",
      message: e instanceof Error ? e.message : "Unknown error",
      checkedAt: now,
    };
  }
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function parseIntHeader(headers: Headers, name: string): number | undefined {
  const val = headers.get(name);
  if (val === null) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function extractRateLimits(headers: Headers): RateLimitInfo {
  return {
    requestsLimit: parseIntHeader(headers, "anthropic-ratelimit-requests-limit"),
    requestsRemaining: parseIntHeader(headers, "anthropic-ratelimit-requests-remaining"),
    tokensLimit: parseIntHeader(headers, "anthropic-ratelimit-tokens-limit"),
    tokensRemaining: parseIntHeader(headers, "anthropic-ratelimit-tokens-remaining"),
  };
}

/**
 * Format a health result into a short display string.
 * Examples: "Valid", "Invalid", "Rate limited", "Error: ..."
 */
export function formatHealthStatus(result: KeyHealthResult): string {
  switch (result.status) {
    case "valid": return "Valid";
    case "invalid": return "Invalid";
    case "rate_limited": return "Rate limited";
    case "error": return `Error: ${result.message}`;
    case "checking": return "Checking...";
  }
}

/**
 * Format rate limit info for display.
 * Example: "80k/80k req · 2M/4M tok"
 */
export function formatRateLimits(info: RateLimitInfo): string {
  const parts: string[] = [];
  if (info.requestsRemaining !== undefined && info.requestsLimit !== undefined) {
    parts.push(`${fmtK(info.requestsRemaining)}/${fmtK(info.requestsLimit)} req`);
  }
  if (info.tokensRemaining !== undefined && info.tokensLimit !== undefined) {
    parts.push(`${fmtK(info.tokensRemaining)}/${fmtK(info.tokensLimit)} tok`);
  }
  return parts.join(" · ") || "No rate limit data";
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${+k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${+m.toFixed(1)}M`;
}
