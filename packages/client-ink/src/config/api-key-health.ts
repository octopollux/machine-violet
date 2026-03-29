/**
 * API key health types and formatting for the client.
 * The actual health check is done server-side via REST.
 */

export interface RateLimitInfo {
  requestsRemaining: number;
  requestsLimit: number;
  tokensRemaining: number;
  tokensLimit: number;
}

export interface KeyHealthResult {
  status: "valid" | "invalid" | "error" | "rate_limited" | "checking";
  message?: string;
  rateLimits?: RateLimitInfo;
}

/** Format rate limit info for display. */
export function formatRateLimits(info: RateLimitInfo): string {
  const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  return `${fmtK(info.requestsRemaining)}/${fmtK(info.requestsLimit)} req \u00b7 ${fmtK(info.tokensRemaining)}/${fmtK(info.tokensLimit)} tok`;
}
