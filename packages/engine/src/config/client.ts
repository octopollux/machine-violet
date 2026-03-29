/**
 * Anthropic client factory.
 *
 * Every call site should use `createClient()` instead of `new Anthropic()`
 * so that default headers (app identification, etc.) are applied consistently.
 */
import Anthropic from "@anthropic-ai/sdk";

export function createClient(
  opts?: ConstructorParameters<typeof Anthropic>[0],
): Anthropic {
  return new Anthropic({
    defaultHeaders: { "x-app-name": "machine-violet" },
    ...opts,
  });
}
