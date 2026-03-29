/**
 * Theme styler subagent — translates natural-language theme requests
 * into concrete theme commands via a Haiku one-shot.
 *
 * The DM calls `style_scene` with a description like "cyberpunk neon"
 * or "make it darker". This subagent picks the right theme, key_color,
 * preset, and gradient, returning a TuiCommand for the engine to dispatch.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { TuiCommand } from "../agent-loop.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("theme-styler");

export interface ThemeStylerResult extends SubagentResult {
  /** The parsed theme command to dispatch, or null if parsing failed */
  command: TuiCommand | null;
}

/**
 * Invoke the theme styler subagent.
 *
 * @param client - Anthropic client
 * @param description - Natural-language theme request from the DM
 * @param currentTheme - Current theme name (for context)
 * @param currentKeyColor - Current key color hex (for context)
 */
export async function styleTheme(
  client: Anthropic,
  description: string,
  currentTheme?: string,
  currentKeyColor?: string,
): Promise<ThemeStylerResult> {
  const contextParts: string[] = [];
  if (currentTheme) contextParts.push(`Current theme: ${currentTheme}`);
  if (currentKeyColor) contextParts.push(`Current key color: ${currentKeyColor}`);
  const context = contextParts.length > 0 ? contextParts.join(". ") + "\n\n" : "";

  const userMessage = `${context}Request: ${description}`;

  const result = await oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    userMessage,
    200,
    "theme-styler",
  );

  const command = parseThemeResponse(result.text);
  return { ...result, command };
}

/**
 * Parse the subagent's JSON response into a TuiCommand.
 * Tolerant of markdown fences and whitespace.
 */
function parseThemeResponse(text: string): TuiCommand | null {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const cmd: TuiCommand = { type: "set_theme" };

    if (typeof parsed.theme === "string") cmd.theme = parsed.theme;
    if (typeof parsed.key_color === "string") cmd.key_color = parsed.key_color;
    // preset and gradient aren't directly settable via TuiCommand yet —
    // they're determined by the theme definition. But key_color + theme
    // selection is enough to get the desired look.

    // Only return a command if at least one field was set
    if (cmd.theme || cmd.key_color) return cmd;
    return null;
  } catch {
    return null;
  }
}
