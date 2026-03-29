/**
 * Provider factory and re-exports.
 */
export type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedTool, NormalizedToolCall,
  NormalizedUsage, ContentPart, SystemBlock, StopReason,
  CacheHint, ThinkingConfig,
} from "./types.js";

export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAIProvider } from "./openai.js";
export type { OpenAIProviderOptions } from "./openai.js";
