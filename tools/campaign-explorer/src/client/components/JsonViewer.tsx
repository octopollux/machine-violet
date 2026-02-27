import { useState, type ReactNode } from "react";
import { findColors } from "../lib/color-swatch";

interface JsonViewerProps {
  content: string;
}

/** Render a JSON value with syntax coloring and collapsible objects/arrays. */
function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "boolean")
    return <span className="json-boolean">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="json-number">{value}</span>;
  if (typeof value === "string") return <JsonString value={value} />;

  if (Array.isArray(value)) return <JsonArray items={value} depth={depth} />;
  if (typeof value === "object")
    return <JsonObject obj={value as Record<string, unknown>} depth={depth} />;

  return <span>{String(value)}</span>;
}

function JsonString({ value }: { value: string }) {
  const colors = findColors(value);
  const escaped = JSON.stringify(value);

  if (colors.length === 0) {
    return <span className="json-string">{escaped}</span>;
  }

  return (
    <span className="json-string">
      {escaped}
      {colors.map((c, i) => (
        <span
          key={i}
          className="color-swatch"
          style={{ backgroundColor: c.color }}
        />
      ))}
    </span>
  );
}

function JsonArray({ items, depth }: { items: unknown[]; depth: number }) {
  const [collapsed, setCollapsed] = useState(depth > 2);
  const indent = "  ".repeat(depth + 1);
  const closingIndent = "  ".repeat(depth);

  if (items.length === 0) return <span>{"[]"}</span>;

  if (collapsed) {
    return (
      <span
        className="json-collapsible"
        onClick={() => setCollapsed(false)}
      >
        {"[..."}{items.length}{" items]"}
      </span>
    );
  }

  return (
    <span>
      <span
        className="json-collapsible"
        onClick={() => setCollapsed(true)}
      >
        {"["}
      </span>
      {"\n"}
      {items.map((item, i) => (
        <span key={i}>
          {indent}
          <JsonNode value={item} depth={depth + 1} />
          {i < items.length - 1 ? "," : ""}
          {"\n"}
        </span>
      ))}
      {closingIndent}{"]"}
    </span>
  );
}

function JsonObject({
  obj,
  depth,
}: {
  obj: Record<string, unknown>;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(depth > 2);
  const keys = Object.keys(obj);
  const indent = "  ".repeat(depth + 1);
  const closingIndent = "  ".repeat(depth);

  if (keys.length === 0) return <span>{"{}"}</span>;

  if (collapsed) {
    return (
      <span
        className="json-collapsible"
        onClick={() => setCollapsed(false)}
      >
        {"{..."}{keys.length}{" keys}"}
      </span>
    );
  }

  return (
    <span>
      <span
        className="json-collapsible"
        onClick={() => setCollapsed(true)}
      >
        {"{"}
      </span>
      {"\n"}
      {keys.map((key, i) => (
        <span key={key}>
          {indent}
          <span className="json-key">{JSON.stringify(key)}</span>
          {": "}
          <JsonNode value={obj[key]} depth={depth + 1} />
          {i < keys.length - 1 ? "," : ""}
          {"\n"}
        </span>
      ))}
      {closingIndent}{"}"}
    </span>
  );
}

export function JsonViewer({ content }: JsonViewerProps) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return (
      <div className="json-viewer">
        <pre>{content}</pre>
      </div>
    );
  }

  return (
    <div className="json-viewer">
      <pre>
        <JsonNode value={parsed} />
      </pre>
    </div>
  );
}
