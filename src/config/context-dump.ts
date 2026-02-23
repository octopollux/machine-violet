import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isDevMode } from "./dev-mode.js";

// --- Module-level state (same pattern as dev-mode.ts) ---

let dumpDir: string | null = null;

/**
 * Set the context dump output directory. Called once at campaign start.
 * Creates the directory tree (fire-and-forget).
 */
export function setContextDumpDir(dir: string): void {
  dumpDir = dir;
  void mkdir(dir, { recursive: true }).catch(() => {});
}

/** Get the current dump directory (for testing). */
export function getContextDumpDir(): string | null {
  return dumpDir;
}

/** Reset state (for tests). */
export function resetContextDump(): void {
  dumpDir = null;
}

// --- Types ---

/** Shape accepted by dumpContext — structural subset of Anthropic CreateParams. */
export interface DumpableParams {
  model: string;
  max_tokens: number;
  system: string | readonly SystemBlock[];
  messages: readonly MessageParam[];
  tools?: readonly ToolDef[];
}

interface SystemBlock {
  type: string;
  text: string;
  cache_control?: unknown;
}

interface MessageParam {
  role: string;
  content: unknown;
}

interface ToolDef {
  name: string;
  description?: string;
  [k: string]: unknown;
}

// --- Public API ---

/**
 * Dump context to a file. Fire-and-forget, errors swallowed.
 * Only runs when DEV_MODE is active and dumpDir has been set.
 */
export function dumpContext(agentName: string, params: DumpableParams): void {
  if (!isDevMode() || !dumpDir) return;

  const text = renderDump(agentName, params);
  const filePath = join(dumpDir, `${agentName}.txt`);

  void writeFile(filePath, text, "utf-8").catch(() => {});
}

// --- Rendering (exported for tests) ---

/** Render a full context dump as human-readable text. */
export function renderDump(agentName: string, params: DumpableParams): string {
  const lines: string[] = [];

  // Header
  lines.push(`=== CONTEXT DUMP: ${agentName} ===`);
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Model: ${params.model}`);
  lines.push(`Max Tokens: ${params.max_tokens}`);
  lines.push("");

  // System prompt
  lines.push("=== SYSTEM PROMPT ===");
  if (typeof params.system === "string") {
    lines.push(params.system);
  } else if (Array.isArray(params.system)) {
    for (let i = 0; i < params.system.length; i++) {
      const block = params.system[i];
      const cc = block.cache_control as { type: string; ttl?: string } | undefined;
      const cached = cc ? (cc.ttl ? ` [cached:${cc.ttl}]` : " [cached]") : "";
      lines.push(`--- block ${i + 1}${cached} ---`);
      lines.push(block.text);
    }
  }
  lines.push("");

  // Tools (part of cacheable prefix, before messages)
  const tools = params.tools;
  if (tools && tools.length > 0) {
    lines.push(`=== TOOLS (${tools.length}) ===`);
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const desc = (tool.description ?? "").split("\n")[0];
      const cc = (tool as Record<string, unknown>)["cache_control"] as { type: string; ttl?: string } | undefined;
      const cached = cc ? (cc.ttl ? ` [cached:${cc.ttl}]` : " [cached]") : "";
      lines.push(`${i + 1}. ${tool.name} - ${desc}${cached}`);
    }
    lines.push("");
  }

  // Messages
  lines.push(`=== MESSAGES (${params.messages.length}) ===`);
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i];
    lines.push("");
    lines.push(`--- [${i + 1}] ${msg.role} ---`);
    lines.push(renderContent(msg.content));
  }
  lines.push("");

  lines.push("=== END ===");
  return lines.join("\n");
}

/** Render message content to human-readable text. */
export function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text":
          parts.push(b.text as string);
          break;
        case "tool_use":
          parts.push(`[tool_use: ${b.name as string}(${JSON.stringify(b.input)})]`);
          break;
        case "tool_result": {
          const text = typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content);
          const truncated = text.length > 200
            ? text.slice(0, 200) + "..."
            : text;
          const errFlag = b.is_error ? " ERROR" : "";
          parts.push(`[tool_result: ${b.tool_use_id as string}${errFlag} | ${truncated}]`);
          break;
        }
        case "image": {
          const src = b.source as Record<string, unknown> | undefined;
          parts.push(`[image: ${src?.media_type ?? "unknown"}]`);
          break;
        }
        default:
          parts.push(`[${b.type as string}: ${JSON.stringify(b)}]`);
      }
    }
  }
  return parts.join("\n");
}
