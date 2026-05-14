/**
 * Resolves the `clientInfo` object passed to `codex app-server`'s
 * `initialize` JSON-RPC call.
 *
 * `clientInfo.name` flows through to the OAuth `originator` query
 * parameter and OpenAI's compliance logging. Per the developers.openai.com
 * codex/app-server docs, OpenAI maintains a known-clients list for
 * third-party integrations. The `MV_CHATGPT_ORIGINATOR` env var lets us
 * experiment with different originator values during integration without
 * recompiling — useful both for testing the allowlist boundary and for
 * future operations once OpenAI registers a name for us.
 */

const DEFAULT_NAME = "machine_violet";
const DEFAULT_TITLE = "Machine Violet";
const DEFAULT_VERSION = "1.0.1";

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export function getCodexClientInfo(): CodexClientInfo {
  const override = process.env.MV_CHATGPT_ORIGINATOR?.trim();
  return {
    name: override && override.length > 0 ? override : DEFAULT_NAME,
    title: DEFAULT_TITLE,
    version: DEFAULT_VERSION,
  };
}
