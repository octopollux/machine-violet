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
import { refreshAccessToken, type OAuthTokens } from "./oauth.js";

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
  /**
   * Load the current refresh_token, exchange it for a fresh access_token
   * bundle, persist the result, and return it. Concurrent callers
   * targeting the same persisted record coalesce onto a single in-flight
   * refresh — first call rotates the refresh_token, the rest await its
   * result and read the new bundle. Without this coalescing, two callers
   * racing past `load()` would both POST grant_type=refresh_token with
   * the same RT; OpenAI rotates RTs on each call, so the second request
   * fails with "refresh token already used".
   *
   * Returns `null` when no tokens are stored (caller should re-prompt
   * sign-in).
   */
  refresh(): Promise<PersistedChatGptTokens | null>;
}

/**
 * Per-(configDir, connectionId) refresh mutex. Module-scoped so two
 * stores created against the same persisted record share the lock —
 * `createConnectionTokenStore` is called once per provider instance,
 * and a session may have multiple provider instances for the same
 * connection (DM + setup + theme-styler), each calling `refresh()`.
 */
const inflightRefresh = new Map<string, Promise<PersistedChatGptTokens | null>>();

/** Test-only escape hatch: clear the refresh mutex between tests. */
export function _resetRefreshLocksForTest(): void {
  inflightRefresh.clear();
}

/**
 * Connection-backed store: reads/writes `chatgptAccount` on the
 * AIConnection identified by `connectionId` in `connections.json`.
 *
 * `refreshFn` is injectable for unit tests; production callers omit it
 * and get the real OpenAI token-endpoint exchange.
 */
export function createConnectionTokenStore(
  configDir: string,
  connectionId: string,
  refreshFn: (refreshToken: string) => Promise<OAuthTokens> = refreshAccessToken,
): ChatGptTokenStore {
  const lockKey = `${configDir}::${connectionId}`;

  const load = (): PersistedChatGptTokens | null => {
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
  };

  const save = (tokens: PersistedChatGptTokens): void => {
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
  };

  const refresh = async (): Promise<PersistedChatGptTokens | null> => {
    const existing = inflightRefresh.get(lockKey);
    if (existing) return existing;

    const promise = (async (): Promise<PersistedChatGptTokens | null> => {
      const current = load();
      if (!current) return null;
      const oauth = await refreshFn(current.refreshToken);
      const fresh = tokensFromOAuth(oauth, current.chatgptAccountId);
      if (!fresh) return null;
      save(fresh);
      return fresh;
    })();

    inflightRefresh.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      // Guard against a later refresh() having already replaced the entry
      // (shouldn't happen because we await before clearing, but defensive).
      if (inflightRefresh.get(lockKey) === promise) {
        inflightRefresh.delete(lockKey);
      }
    }
  };

  return { load, save, refresh };
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
