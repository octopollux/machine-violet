/**
 * Provider factory and re-exports.
 */
import type { AIConnection } from "../config/connections.js";
import type { LLMProvider } from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";

export type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedTool, NormalizedToolCall,
  NormalizedUsage, ContentPart, SystemBlock, StopReason,
  CacheHint, ThinkingConfig,
} from "./types.js";

export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAIProvider } from "./openai.js";
export type { OpenAIProviderOptions } from "./openai.js";

/**
 * Create an LLMProvider from a connection definition.
 */
export function createProviderFromConnection(conn: AIConnection): LLMProvider {
  switch (conn.provider) {
    case "anthropic":
      return createAnthropicProvider(conn.apiKey);

    case "openai":
    case "openai-oauth":
      return createOpenAIProvider({
        apiKey: conn.apiKey,
        providerId: conn.provider,
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

    default:
      throw new Error(`Unknown provider type: ${conn.provider}`);
  }
}
