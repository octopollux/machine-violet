import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";
import { findColors } from "../lib/color-swatch";

interface MarkdownViewerProps {
  content: string;
  onNavigate?: (target: string) => void;
}

/** Parse **Key:** Value front matter lines from entity markdown. */
function parseFrontMatter(content: string): {
  title: string | null;
  fields: Array<{ key: string; value: string }>;
  body: string;
} {
  const lines = content.split("\n");
  let i = 0;

  // Skip blanks
  while (i < lines.length && lines[i].trim() === "") i++;

  let title: string | null = null;
  if (i < lines.length && lines[i].startsWith("# ")) {
    title = lines[i].slice(2).trim();
    i++;
  }

  while (i < lines.length && lines[i].trim() === "") i++;

  const fields: Array<{ key: string; value: string }> = [];
  const fmPattern = /^\*\*([^*]+):\*\*\s*(.*)$/;
  while (i < lines.length) {
    const match = lines[i].match(fmPattern);
    if (match) {
      fields.push({ key: match[1].trim(), value: match[2].trim() });
      i++;
    } else {
      break;
    }
  }

  return { title, fields, body: lines.slice(i).join("\n") };
}

/** Replace [[wikilinks]] with clickable spans. */
function processWikilinks(
  text: string,
  onNavigate?: (target: string) => void,
): ReactNode[] {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return parts.map((part, idx) => {
    const wikiMatch = part.match(/^\[\[([^\]]+)\]\]$/);
    if (wikiMatch) {
      const target = wikiMatch[1];
      return (
        <span
          key={idx}
          className="wikilink"
          onClick={() => onNavigate?.(target)}
        >
          {target}
        </span>
      );
    }
    return <span key={idx}>{renderWithColorSwatches(part)}</span>;
  });
}

/** Render inline color swatches next to hex codes. */
function renderWithColorSwatches(text: string): ReactNode[] {
  const colors = findColors(text);
  if (colors.length === 0) return [text];

  const result: ReactNode[] = [];
  let lastEnd = 0;

  for (const { color, index } of colors) {
    if (index > lastEnd) {
      result.push(text.slice(lastEnd, index));
    }
    result.push(text.slice(index, index + color.length));
    result.push(
      <span
        key={`swatch-${index}`}
        className="color-swatch"
        style={{ backgroundColor: color }}
      />,
    );
    lastEnd = index + color.length;
  }
  if (lastEnd < text.length) {
    result.push(text.slice(lastEnd));
  }
  return result;
}

export function MarkdownViewer({ content, onNavigate }: MarkdownViewerProps) {
  const { title, fields, body } = parseFrontMatter(content);

  return (
    <div className="markdown-viewer">
      {title && <h1>{processWikilinks(title, onNavigate)}</h1>}
      {fields.length > 0 && (
        <table className="frontmatter-table">
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td>{f.key}</td>
                <td>{processWikilinks(f.value, onNavigate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReactMarkdown
        components={{
          p: ({ children }) => (
            <p>
              {typeof children === "string"
                ? processWikilinks(children, onNavigate)
                : children}
            </p>
          ),
          li: ({ children }) => (
            <li>
              {typeof children === "string"
                ? processWikilinks(children, onNavigate)
                : children}
            </li>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
