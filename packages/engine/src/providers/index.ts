/**
 * Provider factory and re-exports.
 */
import type { AIConnection } from "../config/connections.js";
import type { LLMProvider } from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createOpenAIChatGptProvider, createConnectionTokenStore, allocateCodexHome, sweepStaleCodexHomesOnce } from "./openai-chatgpt/index.js";

export type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedTool, NormalizedToolCall,
  NormalizedUsage, ContentPart, SystemBlock, StopReason,
  CacheHint, ThinkingConfig,
} from "./types.js";

export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAIProvider } from "./openai.js";
export type { OpenAIProviderOptions } from "./openai.js";
export {
  createOpenAIChatGptProvider, OpenAIChatGptProvider, CodexRpcError, CodexRpcClient,
  getAccount, isChatGptAccount, startChatGptLogin, startChatGptDeviceCodeLogin,
  awaitLoginCompletion, cancelLogin, logout, listModels, toUsageStatus, resolveCodexBinary,
} from "./openai-chatgpt/index.js";
export type { OpenAIChatGptProviderOptions, DiscoveredCodexModel } from "./openai-chatgpt/index.js";

export interface CreateProviderOptions {
  /**
   * Config directory used to back the chatgptAuthTokens token store
   * (for `openai-chatgpt` connections). When absent, the provider runs
   * without persistence — it falls back to whatever codex has cached in
   * `~/.codex/auth.json` and can't refresh tokens itself, so sessions
   * exceeding the access-token lifetime will fail. Other providers
   * ignore this.
   */
  configDir?: string;
}

/**
 * Create an LLMProvider from a connection definition.
 *
 * For `openai-chatgpt` connections this returns a stateful provider that
 * owns a `codex app-server` subprocess; the subprocess is spawned lazily
 * on first chat() call. The caller is responsible for invoking
 * `provider.dispose()` when the session ends.
 */
export function createProviderFromConnection(conn: AIConnection, opts: CreateProviderOptions = {}): LLMProvider {
  switch (conn.provider) {
    case "anthropic":
      return createAnthropicProvider(conn.apiKey);

    case "openai-apikey":
      return createOpenAIProvider({
        apiKey: conn.apiKey,
        providerId: "openai-apikey",
      });

    case "openrouter":
      return createOpenAIProvider({
        apiKey: conn.apiKey,
        baseURL: conn.baseUrl ?? "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/octopollux/machine-violet",
          "X-Title": "Machine Violet",
        },
        providerId: "openrouter",
      });

    case "custom":
      return createOpenAIProvider({
        apiKey: conn.apiKey,
        baseURL: conn.baseUrl,
        providerId: "custom",
      });

    case "openai-chatgpt": {
      // Subprocess is spawned lazily on first chat() call; the session
      // manager calls provider.dispose() at session end. Token storage
      // is mediated through a connection-backed store so refreshed
      // tokens are persisted back to connections.json automatically.
      const tokenStore = opts.configDir ? createConnectionTokenStore(opts.configDir, conn.id) : undefined;
      // Isolate this codex subprocess in its own CODEX_HOME so concurrent
      // subprocesses (parallel sessions, the setup→game handoff, batch probes)
      // don't contend on one shared `~/.codex` SQLite state runtime and crash
      // with `code=1` `(code: 1546) disk I/O error` — root-caused + fixed live
      // (see codex-home.ts). Only when we have a tokenStore to push auth over
      // RPC: the no-tokenStore fallback authenticates from `~/.codex/auth.json`,
      // so it must keep the default home. A one-time date-sweep reaps any homes
      // leaked by a past crash (dispose() removes them in the normal case).
      let codexHome: string | undefined;
      if (tokenStore) {
        sweepStaleCodexHomesOnce(Date.now());
        codexHome = allocateCodexHome(conn.id);
      }
      return createOpenAIChatGptProvider({ tokenStore, codexHome });
    }

    default:
      throw new Error(`Unknown provider type: ${conn.provider}`);
  }
}
