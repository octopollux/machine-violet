import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

interface ContextDumpViewerProps {
  content: string;
}

/**
 * One api:call event from engine.jsonl. Fields are optional because older
 * log lines may pre-date the cacheCreation addition.
 */
interface ApiCallEvent {
  t?: number;
  agent?: string;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoningTokens?: number;
  toolCalls?: number;
  stopReason?: string;
}

interface ThinkingTrace {
  round: number;
  thinking: string;
  timestamp: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  thinking?: string;
}

interface Message {
  role: string;
  content: string | ContentBlock[];
}

interface ToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

interface ContextDump {
  agent: string;
  timestamp: string;
  model?: string;
  // Engine SystemBlocks are `{ text, cacheControl? }` — no `type` field —
  // but older dumps from the Anthropic SDK shape include `{ type: "text", text }`.
  system?: string | Array<{ type?: string; text?: string; cacheControl?: { ttl: "5m" | "1h" } }>;
  messages?: Message[];
  tools?: ToolDef[];
  _thinking_trace?: ThinkingTrace[];
  [key: string]: unknown;
}

/** Try to pretty-print as JSON; fall back to the raw value for plain text. */
function prettyPrint(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

function Section({
  title,
  color,
  defaultOpen = true,
  children,
}: {
  title: string;
  color: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="dump-section">
      <div
        className="dump-section-header"
        style={{ background: `${color}15`, color }}
        onClick={() => setOpen(!open)}
      >
        {open ? "\u25BE" : "\u25B8"} {title}
      </div>
      {open && <div className="dump-section-content">{children}</div>}
    </div>
  );
}

function MessageBlock({ msg }: { msg: Message }) {
  const roleClass = `dump-message role-${msg.role}`;

  const renderContent = (content: string | ContentBlock[]): ReactNode => {
    if (typeof content === "string") {
      return <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>;
    }
    return content.map((block, i) => {
      if (block.type === "text" && block.text) {
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>
            {block.text}
          </div>
        );
      }
      if (block.type === "thinking" && block.thinking) {
        return (
          <div key={i} className="dump-thinking">
            {block.thinking}
          </div>
        );
      }
      if (block.type === "tool_use") {
        return (
          <div key={i} className="dump-message role-tool_use">
            <div className="dump-role-label">tool_use: {block.name}</div>
            <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
        );
      }
      if (block.type === "tool_result") {
        return (
          <div key={i} className="dump-message role-tool_result">
            <div className="dump-role-label">tool_result ({block.tool_use_id})</div>
            <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {prettyPrint(block.content)}
            </pre>
          </div>
        );
      }
      return (
        <pre key={i} style={{ fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {JSON.stringify(block, null, 2)}
        </pre>
      );
    });
  };

  return (
    <div className={roleClass}>
      <div className="dump-role-label">{msg.role}</div>
      {renderContent(msg.content)}
    </div>
  );
}

function ToolsList({ tools }: { tools: ToolDef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      <div className="dump-tools-list">
        {tools.map((t) => (
          <span
            key={t.name}
            className="dump-tool-chip"
            onClick={() => setExpanded(expanded === t.name ? null : t.name)}
          >
            {t.name}
          </span>
        ))}
      </div>
      {expanded && (
        <div className="dump-tool-detail">
          <pre>
            {JSON.stringify(
              tools.find((t) => t.name === expanded),
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

type SystemBlockLike = { type?: string; text?: string; cacheControl?: { ttl: "5m" | "1h" } };

/**
 * Flatten a dumped system-prompt field into plain text.
 * Engine blocks have no `type` field; accept any block with `text`.
 * Keep the optional `type === "text"` path so SDK-shaped blocks still render.
 * Exported for contract-test coverage against regressions like #403.
 */
export function systemPromptToText(system: string | SystemBlockLike[]): string {
  if (typeof system === "string") return system;
  return system
    .filter((b) => b.text && (b.type === undefined || b.type === "text"))
    .map((b) => b.text)
    .join("\n\n");
}

function SystemPrompt({ system }: { system: string | SystemBlockLike[] }) {
  const text = systemPromptToText(system);

  return (
    <div className="markdown-viewer">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

/**
 * Build an interleaved view of messages and thinking traces.
 * Thinking traces are inserted before each assistant response in the
 * matching round, giving a natural "thought then spoke" reading order.
 *
 * Round mapping: round 0 → before the first assistant message,
 * round 1 → before the second, etc.
 */
function InterleavedMessages({
  messages,
  traces,
  events,
}: {
  messages: Message[];
  traces: ThinkingTrace[];
  /**
   * api:call events for this agent. Paired with assistant messages by index
   * from the tail (events are already filtered; we align the last N of them
   * to the N assistant messages in the dump).
   */
  events: ApiCallEvent[] | null;
}) {
  // Index traces by round for O(1) lookup
  const tracesByRound = new Map<number, ThinkingTrace[]>();
  for (const t of traces) {
    const list = tracesByRound.get(t.round) ?? [];
    list.push(t);
    tracesByRound.set(t.round, list);
  }

  // Count assistant messages to align events to rounds from the tail.
  const assistantTotal = messages.filter((m) => m.role === "assistant").length;
  const eventOffset = events ? Math.max(0, events.length - assistantTotal) : 0;

  const elements: ReactNode[] = [];
  let assistantCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Insert thinking traces + stats chip before each assistant message
    if (msg.role === "assistant") {
      const roundTraces = tracesByRound.get(assistantCount);
      if (roundTraces) {
        for (const t of roundTraces) {
          elements.push(
            <div key={`think-${assistantCount}-${elements.length}`} className="dump-thinking">
              <div style={{ fontSize: 10, marginBottom: 4, opacity: 0.7 }}>
                Round {t.round} thinking | {t.timestamp}
              </div>
              {t.thinking}
            </div>,
          );
        }
      }
      const event = events?.[eventOffset + assistantCount];
      if (event) {
        elements.push(<TurnStatsChip key={`stats-${assistantCount}`} round={assistantCount} event={event} />);
      }
      assistantCount++;
    }

    elements.push(<MessageBlock key={`msg-${i}`} msg={msg} />);
  }

  // Any traces for rounds beyond the last assistant message (shouldn't happen
  // normally, but defensive)
  for (const [round, roundTraces] of tracesByRound) {
    if (round >= assistantCount) {
      for (const t of roundTraces) {
        elements.push(
          <div key={`think-tail-${round}-${elements.length}`} className="dump-thinking">
            <div style={{ fontSize: 10, marginBottom: 4, opacity: 0.7 }}>
              Round {t.round} thinking | {t.timestamp}
            </div>
            {t.thinking}
          </div>,
        );
      }
    }
  }

  return <>{elements}</>;
}

function fmtK(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** Fetch api:call events for an agent from the engine log. */
function useApiCallEvents(agent: string): {
  events: ApiCallEvent[] | null;
  error: string | null;
} {
  const [events, setEvents] = useState<ApiCallEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    fetch(`/api/engine-log/api-calls?agent=${encodeURIComponent(agent)}&limit=100`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: ApiCallEvent[]) => { if (!cancelled) setEvents(data); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [agent]);

  return { events, error };
}

/**
 * Compact per-turn stats chip, shown immediately before the assistant
 * message it corresponds to. Green tint = cache-dominated round; red =
 * mostly uncached.
 */
function TurnStatsChip({ round, event }: { round: number; event: ApiCallEvent }) {
  const uncached = event.inputTokens ?? 0;
  const read = event.cacheRead ?? 0;
  const write = event.cacheCreation ?? 0;
  const total = uncached + read + write;
  const readPct = total > 0 ? (read / total) * 100 : 0;

  const bg = total === 0
    ? "rgba(128,128,128,0.08)"
    : readPct > 80
      ? "rgba(46,160,67,0.12)"
      : readPct < 20
        ? "rgba(218,54,51,0.12)"
        : "rgba(128,128,128,0.08)";

  const ts = event.t ? new Date(event.t).toISOString().slice(11, 19) : null;

  return (
    <div
      style={{
        background: bg,
        fontSize: 11,
        padding: "4px 8px",
        margin: "4px 0",
        borderRadius: 4,
        display: "flex",
        gap: 10,
        flexWrap: "wrap",
        fontFamily: "monospace",
      }}
    >
      <span style={{ opacity: 0.8 }}>round {round}</span>
      {ts && <span style={{ opacity: 0.6 }}>{ts}</span>}
      <span>in {fmtK(uncached)}</span>
      <span>out {fmtK(event.outputTokens)}</span>
      <span>cacheR {fmtK(read)}</span>
      <span>cacheW {fmtK(write)}</span>
      {total > 0 && <span style={{ opacity: 0.8 }}>hit {readPct.toFixed(0)}%</span>}
      {(event.toolCalls ?? 0) > 0 && <span>tools {event.toolCalls}</span>}
      {event.durationMs != null && <span style={{ opacity: 0.6 }}>{event.durationMs}ms</span>}
      {event.stopReason && <span style={{ opacity: 0.6 }}>stop:{event.stopReason}</span>}
    </div>
  );
}

/** One-line aggregate across the loaded turn window. */
function TurnsSummary({ events }: { events: ApiCallEvent[] }) {
  let totIn = 0, totRead = 0, totWrite = 0, totOut = 0;
  for (const e of events) {
    totIn += e.inputTokens ?? 0;
    totRead += e.cacheRead ?? 0;
    totWrite += e.cacheCreation ?? 0;
    totOut += e.outputTokens ?? 0;
  }
  const denom = totIn + totRead + totWrite;
  const hitPct = denom > 0 ? ((totRead / denom) * 100).toFixed(1) : "—";
  return (
    <div style={{ fontSize: 11, marginBottom: 8, opacity: 0.85 }}>
      {events.length} turns — cache hit {hitPct}% · in {fmtK(totIn)} · read {fmtK(totRead)}
      {" · write "}{fmtK(totWrite)} · out {fmtK(totOut)}
    </div>
  );
}

export function ContextDumpViewer({ content }: ContextDumpViewerProps) {
  let dump: ContextDump;
  try {
    dump = JSON.parse(content);
  } catch {
    return <pre>{content}</pre>;
  }

  const thinkingTraces = dump._thinking_trace ?? [];
  const hasMessages = dump.messages && dump.messages.length > 0;
  const { events, error: eventsError } = useApiCallEvents(dump.agent);

  return (
    <div className="context-dump-viewer">
      <div style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}>
        Agent: <strong>{dump.agent}</strong> | Model: {dump.model ?? "unknown"} |{" "}
        {dump.timestamp}
      </div>

      {events && events.length > 0 && <TurnsSummary events={events} />}
      {eventsError && (
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
          Turn stats unavailable ({eventsError})
        </div>
      )}

      {dump.system && (
        <Section title="System Prompt" color="var(--role-system)">
          <SystemPrompt system={dump.system} />
        </Section>
      )}

      {dump.tools && dump.tools.length > 0 && (
        <Section
          title={`Tools (${dump.tools.length})`}
          color="var(--role-tool-use)"
          defaultOpen={false}
        >
          <ToolsList tools={dump.tools} />
        </Section>
      )}

      {hasMessages && (
        <Section
          title={`Conversation (${dump.messages!.length} messages${thinkingTraces.length > 0 ? `, ${thinkingTraces.length} thinking` : ""})`}
          color="var(--role-user)"
        >
          <InterleavedMessages messages={dump.messages!} traces={thinkingTraces} events={events} />
        </Section>
      )}

      {!hasMessages && thinkingTraces.length > 0 && (
        <Section title={`Thinking Traces (${thinkingTraces.length})`} color="#f48fb1">
          {thinkingTraces.map((t, i) => (
            <div key={i} className="dump-thinking">
              <div style={{ fontSize: 10, marginBottom: 4, opacity: 0.7 }}>
                Round {t.round} | {t.timestamp}
              </div>
              {t.thinking}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
