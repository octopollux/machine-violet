/**
 * Token persistence abstraction for openai-chatgpt connections.
 *
 * Why: we drive the OAuth flow ourselves (codex's built-in flow gates
 * connectors scopes behind allowlisted originators), which means we
 * also own token storage. Codex stores the access_token in-process
 * only — when it expires, codex calls back into us via
 * `account/chatgptAuthTokens/refresh` and we mint a fresh one using
 * the refresh_token persisted on the connection.
 *
 * The default backend reads/writes the `chatgptAccount` field on an
 * AIConnection record in connections.json. Tests pass a memory-backed
 * impl that doesn't touch disk.
 */
import { loadConnectionStore, saveConnectionStore } from "../../config/connections.js";
import type { OAuthTokens } from "./oauth.js";

/** The subset of token data we actually need to keep around. */
export interface PersistedChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAtMs: number;
  chatgptAccountId: string;
  chatgptPlanType?: string;
  email?: string;
}

export interface ChatGptTokenStore {
  load(): PersistedChatGptTokens | null;
  save(tokens: PersistedChatGptTokens): void;
}

/**
 * Connection-backed store: reads/writes `chatgptAccount` on the
 * AIConnection identified by `connectionId` in `connections.json`.
 */
export function createConnectionTokenStore(configDir: string, connectionId: string): ChatGptTokenStore {
  return {
    load(): PersistedChatGptTokens | null {
      const stored = loadConnectionStore(configDir);
      const conn = stored.connections.find((c) => c.id === connectionId);
      if (!conn?.chatgptAccount) return null;
      const a = conn.chatgptAccount;
      if (!a.accessToken || !a.refreshToken || a.expiresAtMs == null) return null;
      return {
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        idToken: a.idToken,
        expiresAtMs: a.expiresAtMs,
        chatgptAccountId: a.id,
        chatgptPlanType: a.planType,
        email: a.email,
      };
    },
    save(tokens: PersistedChatGptTokens): void {
      const stored = loadConnectionStore(configDir);
      const conn = stored.connections.find((c) => c.id === connectionId);
      if (!conn) return; // connection deleted while we held a reference; drop silently
      conn.chatgptAccount = {
        id: tokens.chatgptAccountId,
        email: tokens.email ?? conn.chatgptAccount?.email,
        planType: tokens.chatgptPlanType ?? conn.chatgptAccount?.planType,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAtMs: tokens.expiresAtMs,
      };
      saveConnectionStore(configDir, stored);
    },
  };
}

/** Convert an OAuth response into the persistence shape (preserves account_id). */
export function tokensFromOAuth(tokens: OAuthTokens, fallbackAccountId?: string): PersistedChatGptTokens | null {
  const accountId = tokens.chatgptAccountId ?? fallbackAccountId;
  if (!accountId) return null;
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    expiresAtMs: tokens.expiresAtMs,
    chatgptAccountId: accountId,
    chatgptPlanType: tokens.chatgptPlanType,
    email: tokens.email,
  };
}
