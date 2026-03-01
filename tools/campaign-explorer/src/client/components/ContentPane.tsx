import { useState, useEffect } from "react";
import { MarkdownViewer } from "./MarkdownViewer";
import { JsonViewer } from "./JsonViewer";
import { ContextDumpViewer } from "./ContextDumpViewer";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { FileCategory } from "../../shared/protocol";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatK(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

interface ContentPaneProps {
  campaignSlug: string | null;
  selectedFile: string | null;
  fileCategory: FileCategory | null;
  /** Increments when the file is externally modified (SSE). */
  refreshKey: number;
  onNavigate?: (target: string) => void;
}

export function ContentPane({
  campaignSlug,
  selectedFile,
  fileCategory,
  refreshKey,
  onNavigate,
}: ContentPaneProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useAutoScroll(content);

  useEffect(() => {
    if (!campaignSlug || !selectedFile) {
      setContent(null);
      return;
    }

    setLoading(true);
    fetch(`/api/campaigns/${campaignSlug}/file/${selectedFile}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.text();
      })
      .then(setContent)
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [campaignSlug, selectedFile, refreshKey]);

  if (!selectedFile) {
    return (
      <div className="content-pane">
        <div className="content-empty">Select a file to view</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="content-pane">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="content-pane">
        <div className="content-empty">Could not load file</div>
      </div>
    );
  }

  const isContextDump =
    fileCategory === "context-dump" ||
    (fileCategory === "thinking" && selectedFile.endsWith(".json"));

  const isJson = selectedFile.endsWith(".json");
  const isMd = selectedFile.endsWith(".md");

  return (
    <div className="content-pane" ref={scrollRef}>
      <div className="content-header">
        <span>{selectedFile}</span>
        <span className="token-count">~{formatK(estimateTokens(content))} tokens</span>
      </div>
      {isContextDump ? (
        <ContextDumpViewer content={content} />
      ) : isJson ? (
        <JsonViewer content={content} />
      ) : isMd ? (
        <MarkdownViewer content={content} onNavigate={onNavigate} />
      ) : (
        <pre style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{content}</pre>
      )}
    </div>
  );
}
