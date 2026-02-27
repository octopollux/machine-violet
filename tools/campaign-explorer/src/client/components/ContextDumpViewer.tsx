import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

interface ContextDumpViewerProps {
  content: string;
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
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Message[];
  tools?: ToolDef[];
  _thinking_trace?: ThinkingTrace[];
  [key: string]: unknown;
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
            <pre style={{ fontSize: 11 }}>
              {JSON.stringify(block.input, null, 2)}
            </pre>
          </div>
        );
      }
      if (block.type === "tool_result") {
        return (
          <div key={i} className="dump-message role-tool_result">
            <div className="dump-role-label">tool_result ({block.tool_use_id})</div>
            <pre style={{ fontSize: 11 }}>
              {typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content, null, 2)}
            </pre>
          </div>
        );
      }
      return (
        <pre key={i} style={{ fontSize: 11 }}>
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

function SystemPrompt({ system }: { system: string | Array<{ type: string; text?: string }> }) {
  const text = typeof system === "string"
    ? system
    : system
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n\n");

  return (
    <div className="markdown-viewer">
      <ReactMarkdown>{text}</ReactMarkdown>
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

  return (
    <div className="context-dump-viewer">
      <div style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 11 }}>
        Agent: <strong>{dump.agent}</strong> | Model: {dump.model ?? "unknown"} |{" "}
        {dump.timestamp}
      </div>

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

      {dump.messages && dump.messages.length > 0 && (
        <Section title={`Messages (${dump.messages.length})`} color="var(--role-user)">
          {dump.messages.map((msg, i) => (
            <MessageBlock key={i} msg={msg} />
          ))}
        </Section>
      )}

      {thinkingTraces.length > 0 && (
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
