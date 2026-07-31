/**
 * Provider metadata for the Connect to AI screens.
 *
 * Every user-facing string about a provider lives here — display name, picker
 * description, where to find a key — so raw provider ids never leak into
 * copy. Order matters: the picker renders top-to-bottom, and the ChatGPT
 * subscription path leads because it is the recommended way to play
 * (subscription pricing and bundled image generation; per-token API keys are
 * markedly more expensive for a full campaign).
 */

export interface ProviderOption {
  /** Wire id sent to the server (or "openai-chatgpt" for the OAuth path). */
  id: string;
  /** Display name — used in titles, labels, and copy. */
  name: string;
  /** One-line description shown in the picker. */
  desc: string;
  /** How this provider authenticates. */
  auth: "key" | "oauth";
  /** Rendered as a trailing badge in the picker. */
  badge?: "recommended" | "experimental";
  /** Where the player can find/create an API key (shown on the key screen). */
  keySource?: string;
  /** Custom endpoints also need a base URL step. */
  needsBaseUrl?: boolean;
  /**
   * Hidden providers are never offered by the wizard but keep their display
   * metadata (labels for dormant/stored connections still resolve). The
   * server enforces the same gate on POST /manage/connections.
   */
  hidden?: boolean;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "openai-chatgpt",
    name: "OpenAI (ChatGPT)",
    desc: "Sign in with your ChatGPT subscription",
    auth: "oauth",
    badge: "recommended",
  },
  {
    id: "openai-apikey",
    name: "OpenAI (API key)",
    desc: "Paste an API key",
    auth: "key",
    keySource: "platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    desc: "Paste an API key",
    auth: "key",
    keySource: "console.anthropic.com",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    desc: "Paste an API key",
    auth: "key",
    keySource: "aistudio.google.com/apikey",
  },
  {
    id: "xai",
    name: "xAI",
    desc: "Paste an API key",
    auth: "key",
    keySource: "console.x.ai",
    // Temporarily hidden pending the Grok 4.6 reliability retest (#749) —
    // Grok 4.5 produced schema-valid but semantically corrupted setup
    // handoffs. The server rejects xai on POST /manage/connections for the
    // same reason. Flip this flag (and the server gate) when #749 closes.
    hidden: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    desc: "Paste an API key (Kimi K3)",
    auth: "key",
    keySource: "openrouter.ai/keys",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    desc: "Any OpenAI-compatible server — untested",
    auth: "key",
    badge: "experimental",
    needsBaseUrl: true,
  },
];

/** Providers the wizard actually offers (hidden ones gated out, see #749). */
export const VISIBLE_PROVIDER_OPTIONS: ProviderOption[] = PROVIDER_OPTIONS.filter((p) => !p.hidden);

/** Display name for a provider id; falls back to the id itself. */
export function providerName(id: string): string {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.name ?? id;
}
