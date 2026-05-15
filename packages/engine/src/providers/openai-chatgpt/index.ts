/**
 * Public surface of the openai-chatgpt provider.
 *
 * Construction is intentionally separate from
 * {@link createProviderFromConnection} in `providers/index.ts`: the codex
 * app-server provider owns a long-lived subprocess + JSON-RPC channel,
 * which doesn't fit the synchronous, stateless factory shape used by
 * Anthropic/OpenAI/OpenRouter. The session manager constructs codex
 * providers explicitly via {@link createOpenAIChatGptProvider} and
 * shuts them down via `provider.dispose()` at session end.
 */
export {
  createOpenAIChatGptProvider,
  OpenAIChatGptProvider,
  CodexRpcError,
} from "./provider.js";
export type { OpenAIChatGptProviderOptions } from "./provider.js";
export { CodexRpcClient } from "./rpc.js";
export type { CodexRpcClientOptions } from "./rpc.js";
export {
  getAccount,
  isChatGptAccount,
  startChatGptLogin,
  startChatGptDeviceCodeLogin,
  startChatGptThirdPartyOAuth,
  pushChatGptAuthTokens,
  awaitLoginCompletion,
  cancelLogin,
  logout,
} from "./auth.js";
export { startOAuthFlow, refreshAccessToken, OPENAI_OAUTH_CONFIG } from "./oauth.js";
export type { OAuthFlow, OAuthTokens } from "./oauth.js";
export { createConnectionTokenStore, tokensFromOAuth } from "./token-store.js";
export type { ChatGptTokenStore, PersistedChatGptTokens } from "./token-store.js";
export { listModels } from "./models.js";
export type { DiscoveredCodexModel } from "./models.js";
export { toUsageStatus } from "./usage.js";
export { resolveCodexBinary } from "./binary.js";
export type { CodexBinaryResolution } from "./binary.js";
export { getCodexClientInfo } from "./client-info.js";
export type { CodexClientInfo } from "./client-info.js";
