/**
 * Authentication flow orchestration for openai-chatgpt connections.
 *
 * Wraps the codex app-server JSON-RPC auth surface so the management
 * routes (and tests) get a small, focused API:
 *
 *   - `getAccount(client)` — current logged-in account or null
 *   - `startChatGptLogin(client)` — kicks off browser OAuth, returns
 *     `{ loginId, authUrl }`. The Codex app-server hosts the loopback
 *     callback on `localhost:1455` (or :1457 fallback) itself.
 *   - `awaitLoginCompletion(client, loginId)` — resolves on the matching
 *     `account/login/completed` notification.
 *   - `cancelLogin(client, loginId)` — cancels a pending flow.
 *   - `logout(client)` — clears stored ChatGPT credentials.
 *
 * Token storage and refresh are owned by Codex (`~/.codex/auth.json`).
 * We never see the access/refresh tokens directly — only the resulting
 * `account` claims (type, email, planType).
 */
import type { CodexRpcClient } from "./rpc.js";
import type {
  AccountReadResult,
  AccountLoginCompletedNotification,
  ChatGptLoginResult,
  ChatGptDeviceCodeLoginResult,
} from "./protocol.js";
import { log } from "./log.js";
import type { OAuthFlow, OAuthTokens } from "./oauth.js";
import { startOAuthFlow } from "./oauth.js";

export async function getAccount(client: CodexRpcClient): Promise<AccountReadResult> {
  return client.call<AccountReadResult>("account/read", {});
}

/** Returns true when the logged-in account is a ChatGPT (not API key) account. */
export function isChatGptAccount(acct: AccountReadResult): boolean {
  return acct.account?.type === "chatgpt" || acct.account?.type === "chatgptAuthTokens";
}

export async function startChatGptLogin(client: CodexRpcClient): Promise<ChatGptLoginResult> {
  const result = await client.call<ChatGptLoginResult>("account/login/start", { type: "chatgpt" });
  log.loginStarted({ type: "chatgpt", loginId: result.loginId });
  return result;
}

/**
 * Start the third-party OAuth flow we drive directly (PKCE + loopback +
 * minimal `openid profile email offline_access` scopes — no codex
 * connectors scopes). Returns the same `{ loginId, authUrl, ... }` shape
 * the management routes need; the caller drives the user to `authUrl`
 * and awaits `result` for the token bundle, then calls
 * {@link pushChatGptAuthTokens} to register them with codex.
 */
export function startChatGptThirdPartyOAuth(opts: { originator: string }): OAuthFlow {
  log.loginStarted({ type: "chatgpt", loginId: "<oauth-pending>" });
  return startOAuthFlow({ originator: opts.originator });
}

/**
 * Hand a freshly-acquired OAuth token bundle to codex via
 * `account/login/start type:"chatgptAuthTokens"`. Codex stores the token
 * in-process and uses it for its backend API calls. Codex will request
 * a refresh via `account/chatgptAuthTokens/refresh` server request when
 * the token expires; that handler is wired up in provider.ts.
 */
export async function pushChatGptAuthTokens(
  client: CodexRpcClient,
  tokens: Pick<OAuthTokens, "accessToken" | "chatgptAccountId" | "chatgptPlanType">,
): Promise<void> {
  if (!tokens.chatgptAccountId) {
    throw new Error("Cannot push ChatGPT auth tokens to codex: missing chatgpt_account_id claim");
  }
  await client.call("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: tokens.accessToken,
    chatgptAccountId: tokens.chatgptAccountId,
    chatgptPlanType: tokens.chatgptPlanType ?? null,
  });
}

export async function startChatGptDeviceCodeLogin(
  client: CodexRpcClient,
): Promise<ChatGptDeviceCodeLoginResult> {
  const result = await client.call<ChatGptDeviceCodeLoginResult>("account/login/start", {
    type: "chatgptDeviceCode",
  });
  log.loginStarted({ type: "chatgptDeviceCode", loginId: result.loginId });
  return result;
}

/**
 * Wait for the `account/login/completed` notification matching the loginId.
 * Resolves with the notification payload on either success or failure —
 * callers should inspect `.success`. Rejects only on timeout.
 */
export function awaitLoginCompletion(
  client: CodexRpcClient,
  loginId: string,
  timeoutMs = 5 * 60_000,
): Promise<AccountLoginCompletedNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`login flow ${loginId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = client.onNotification<AccountLoginCompletedNotification>(
      "account/login/completed",
      (params) => {
        if (params.loginId !== loginId) return;
        clearTimeout(timer);
        unsub();
        log.loginCompleted({
          loginId: params.loginId,
          success: params.success,
          error: params.error ?? undefined,
        });
        resolve(params);
      },
    );
  });
}

export async function cancelLogin(client: CodexRpcClient, loginId: string): Promise<void> {
  await client.call("account/login/cancel", { loginId });
}

export async function logout(client: CodexRpcClient): Promise<void> {
  await client.call("account/logout", {});
}
