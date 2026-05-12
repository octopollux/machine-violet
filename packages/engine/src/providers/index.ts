/**
 * Provider factory and re-exports.
 */
import type { AIConnection } from "../config/connections.js";
import type { LLMProvider } from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createOpenAIChatGptProvider } from "./openai-chatgpt/index.js";

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

/**
 * Create an LLMProvider from a connection definition.
 *
 * For `openai-chatgpt` connections this returns a stateful provider that
 * owns a `codex app-server` subprocess; the subprocess is spawned lazily
 * on first chat() call. The caller is responsible for invoking
 * `provider.dispose()` when the session ends.
 */
export function createProviderFromConnection(conn: AIConnection): LLMProvider {
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

    case "openai-chatgpt":
      // Subprocess is spawned lazily on first chat() call; the session
      // manager calls provider.dispose() at session end.
      return createOpenAIChatGptProvider();

    default:
      throw new Error(`Unknown provider type: ${conn.provider}`);
  }
}
