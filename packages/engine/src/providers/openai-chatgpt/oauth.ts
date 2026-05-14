/**
 * OpenAI ChatGPT OAuth 2.0 PKCE flow, driven by Machine Violet directly.
 *
 * Why not use codex app-server's built-in `account/login/start type:"chatgpt"`?
 * Codex's flow hardcodes the `api.connectors.read api.connectors.invoke` scopes,
 * which on OpenAI's backend gate behind an allowlisted originator. Third-party
 * apps (Cline, OpenClaw, etc.) all drive their own OAuth with the minimal
 * identity scopes and then hand the resulting tokens to codex via
 * `account/login/start type:"chatgptAuthTokens"`. We follow that pattern.
 *
 * Flow:
 *   1. Generate PKCE verifier + challenge
 *   2. Bind localhost:1455 for the OAuth callback
 *   3. Return `{ loginId, authUrl, result }` — caller opens the URL in browser
 *   4. Browser redirects to our loopback with `?code=...&state=...`
 *   5. We exchange code for tokens at auth.openai.com/oauth/token
 *   6. Decode id_token to pull email / account_id / plan_type
 *   7. Resolve `result` with the full token bundle
 *
 * Refresh handling happens elsewhere (provider.ts) — codex sends a
 * `account/chatgptAuthTokens/refresh` server request when its in-memory
 * access token returns 401, and we respond with a fresh access_token by
 * using the refresh_token we stored on the connection.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const OPENAI_OAUTH_CONFIG = {
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access",
  callbackPort: 1455,
  jwtClaimNamespace: "https://api.openai.com/auth",
  httpTimeoutMs: 30_000,
} as const;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAtMs: number;
  email?: string;
  chatgptAccountId?: string;
  chatgptPlanType?: string;
}

export interface OAuthFlow {
  loginId: string;
  authUrl: string;
  cancel: () => void;
  /** Resolves on successful callback + token exchange; rejects on error/cancel. */
  result: Promise<OAuthTokens>;
}

// ---------------------------------------------------------------------------
// PKCE / base64url helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  originator: string;
}): string {
  // Hand-build the query string with `encodeURIComponent` (RFC 3986: spaces
  // become %20) instead of `URLSearchParams.toString()`, which uses the
  // application/x-www-form-urlencoded variant (spaces become +). OpenAI's
  // auth backend is strict about scope encoding and treats `+` literally,
  // which surfaces as a generic `missing_required_parameter` error.
  // Param order mirrors codex's `build_authorize_url` (Rust source). OAuth
  // spec doesn't require an order, but matching codex byte-for-byte rules
  // out one variable when something goes wrong. `codex_cli_simplified_flow`
  // skips the org chooser for users with a single workspace — Cline sets
  // it for third-party apps and it works.
  const entries: [string, string][] = [
    ["response_type", "code"],
    ["client_id", OPENAI_OAUTH_CONFIG.clientId],
    ["redirect_uri", OPENAI_OAUTH_CONFIG.redirectUri],
    ["scope", OPENAI_OAUTH_CONFIG.scopes],
    ["code_challenge", opts.codeChallenge],
    ["code_challenge_method", "S256"],
    ["id_token_add_organizations", "true"],
    ["codex_cli_simplified_flow", "true"],
    ["state", opts.state],
    ["originator", opts.originator],
  ];
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${OPENAI_OAUTH_CONFIG.authorizationEndpoint}?${qs}`;
}

// ---------------------------------------------------------------------------
// JWT payload decoding (no signature verification — we only need claims)
// ---------------------------------------------------------------------------

interface JwtPayload {
  email?: string;
  organizations?: { id?: unknown }[];
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  [key: string]: unknown;
}

function decodeJwtPayload(jwt: string): JwtPayload | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function extractAccountInfo(idToken: string | undefined, accessToken: string): {
  email?: string;
  chatgptAccountId?: string;
  chatgptPlanType?: string;
} {
  const payload: JwtPayload =
    (idToken ? decodeJwtPayload(idToken) : null)
    ?? decodeJwtPayload(accessToken)
    ?? {};
  const authClaims = (payload[OPENAI_OAUTH_CONFIG.jwtClaimNamespace] as Record<string, unknown> | undefined) ?? {};

  const email = typeof payload.email === "string" ? payload.email : undefined;

  let chatgptAccountId: string | undefined;
  if (typeof authClaims.chatgpt_account_id === "string") chatgptAccountId = authClaims.chatgpt_account_id;
  if (!chatgptAccountId && Array.isArray(payload.organizations) && payload.organizations.length > 0) {
    const first = payload.organizations[0];
    if (typeof first?.id === "string") chatgptAccountId = first.id;
  }
  if (!chatgptAccountId && typeof payload.chatgpt_account_id === "string") {
    chatgptAccountId = payload.chatgpt_account_id;
  }

  let chatgptPlanType: string | undefined;
  if (typeof authClaims.chatgpt_plan_type === "string") chatgptPlanType = authClaims.chatgpt_plan_type;
  if (!chatgptPlanType && typeof payload.chatgpt_plan_type === "string") {
    chatgptPlanType = payload.chatgpt_plan_type;
  }

  return { email, chatgptAccountId, chatgptPlanType };
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  email?: string;
  token_type?: string;
}

async function postToTokenEndpoint(body: URLSearchParams): Promise<RawTokenResponse> {
  const res = await fetch(OPENAI_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(OPENAI_OAUTH_CONFIG.httpTimeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<RawTokenResponse>;
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<OAuthTokens> {
  const json = await postToTokenEndpoint(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: OPENAI_OAUTH_CONFIG.redirectUri,
  }));
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("token response missing required fields");
  }
  const info = extractAccountInfo(json.id_token, json.access_token);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
    email: info.email ?? json.email,
    chatgptAccountId: info.chatgptAccountId,
    chatgptPlanType: info.chatgptPlanType,
  };
}

/**
 * Exchange a stored refresh_token for a fresh access_token bundle. OpenAI may
 * or may not rotate the refresh_token — we honor whichever value comes back.
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const json = await postToTokenEndpoint(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    refresh_token: refreshToken,
    scope: OPENAI_OAUTH_CONFIG.scopes,
  }));
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("refresh response missing required fields");
  }
  const info = extractAccountInfo(json.id_token, json.access_token);
  return {
    accessToken: json.access_token,
    // OpenAI sometimes rotates the refresh token, sometimes echoes the same one.
    // Keep whichever it returns; fall back to the original if absent.
    refreshToken: json.refresh_token ?? refreshToken,
    idToken: json.id_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
    email: info.email ?? json.email,
    chatgptAccountId: info.chatgptAccountId,
    chatgptPlanType: info.chatgptPlanType,
  };
}

// ---------------------------------------------------------------------------
// Flow orchestration: loopback HTTP server + auth URL
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><title>Signed in</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 64px 24px; text-align: center; background:#0c0010; color:#f0e6f6; }
  h1 { color:#c8a2ff; font-weight: 600; }
  p { color:#a890c0; }
</style></head>
<body>
<h1>Signed in to Machine Violet</h1>
<p>You can close this tab and return to your terminal.</p>
</body></html>`;

export function startOAuthFlow(opts: { originator: string; port?: number }): OAuthFlow {
  const port = opts.port ?? OPENAI_OAUTH_CONFIG.callbackPort;
  const loginId = randomUUID();
  const state = base64UrlEncode(randomBytes(16));
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const authUrl = buildAuthorizeUrl({ state, codeChallenge: challenge, originator: opts.originator });

  let resolveResult!: (tokens: OAuthTokens) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<OAuthTokens>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = createServer((req, res) => {
    void handleCallback(req, res).catch((err: unknown) => {
      rejectResult(err instanceof Error ? err : new Error(String(err)));
    });
  });

  server.on("error", (err: Error) => {
    rejectResult(err);
  });

  server.listen(port, "127.0.0.1");

  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
    setTimeout(() => server.close(), 100);
  };

  async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname !== "/auth/callback") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description") ?? "";
      res.statusCode = 400;
      res.end(`OAuth error: ${error} ${desc}`);
      settle(() => rejectResult(new Error(`OAuth error: ${error}${desc ? ` (${desc})` : ""}`)));
      return;
    }
    const returnedState = url.searchParams.get("state");
    if (returnedState !== state) {
      res.statusCode = 400;
      res.end("State mismatch");
      settle(() => rejectResult(new Error("OAuth state mismatch — possible CSRF")));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.statusCode = 400;
      res.end("Missing authorization code");
      settle(() => rejectResult(new Error("OAuth callback missing code")));
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, verifier);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      settle(() => resolveResult(tokens));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.end(`Token exchange failed: ${message}`);
      settle(() => rejectResult(err instanceof Error ? err : new Error(message)));
    }
  }

  return {
    loginId,
    authUrl,
    cancel: () => settle(() => rejectResult(new Error("login cancelled"))),
    result,
  };
}
