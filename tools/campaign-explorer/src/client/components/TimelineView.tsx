import { useEffect, useMemo, useState } from "react";
import type { SpanRecord } from "../../shared/protocol";
import { buildSegments, FlameChart, KIND_COLORS, type HoverState } from "./FlameChart";

/** Zoom presets in pixels-per-millisecond. Default keeps a ~30s turn ~1500px. */
const ZOOM_LEVELS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25];
const DEFAULT_ZOOM_INDEX = 3;

/** Slow poll backstop: covers the dev layout where trace.jsonl isn't SSE-watched. */
const POLL_MS = 5000;

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtK(n: unknown): string {
  if (typeof n !== "number" || !n) return "0";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

/** Fetch the campaign's spans, refetching on `refreshKey` (SSE) plus a slow poll. */
function useSpans(
  campaignSlug: string | null,
  refreshKey: number,
): { spans: SpanRecord[] | null; error: string | null } {
  const [spans, setSpans] = useState<SpanRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Clear any prior campaign's failure so the UI reflects the current fetch
    // lifecycle (otherwise a stale "Failed to load spans" can flash while the
    // newly-selected campaign is still loading).
    setError(null);
    if (!campaignSlug) {
      setSpans(null);
      return;
    }
    let cancelled = false;
    const load = (): void => {
      fetch(`/api/engine-log/spans?campaign=${encodeURIComponent(campaignSlug)}&limit=5000`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: SpanRecord[]) => {
          if (!cancelled) {
            setSpans(data);
            setError(null);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [campaignSlug, refreshKey]);

  return { spans, error };
}

/** Header label for one segment: "turn 5 · Aldric" / the root span's name. */
function segmentLabel(root: SpanRecord): string {
  const num = root.attrs?.turnNumber;
  const who = root.attrs?.participant;
  if (root.kind === "turn" && typeof num === "number") {
    return typeof who === "string" ? `turn ${num} · ${who}` : `turn ${num}`;
  }
  return root.name;
}

function Tooltip({ hover }: { hover: NonNullable<HoverState> }) {
  const s = hover.span;
  const a = s.attrs ?? {};
  const rows: [string, string][] = [];
  if (typeof a.model === "string") rows.push(["model", a.model]);
  if (s.kind === "api_call" || s.kind === "agent") {
    rows.push(["tokens", `in ${fmtK(a.inputTokens)} · out ${fmtK(a.outputTokens)} · cacheR ${fmtK(a.cacheRead)} · cacheW ${fmtK(a.cacheCreation)}`]);
  }
  if (typeof a.rounds === "number") rows.push(["rounds", String(a.rounds)]);
  if (typeof a.toolCalls === "number") rows.push(["tool calls", String(a.toolCalls)]);
  if (typeof a.stopReason === "string") rows.push(["stop", a.stopReason]);
  if (typeof a.attempts === "number") rows.push(["attempts", String(a.attempts)]);
  if (typeof a.effort === "string") rows.push(["effort", a.effort]);
  if (typeof a.aspect === "string") rows.push(["aspect", a.aspect]);
  if (typeof a.cacheMissReason === "string") rows.push(["cache miss", a.cacheMissReason]);
  if (s.isError === true || a.failed === true) rows.push(["status", "error"]);

  // Keep the tooltip on-screen: flip left of the cursor past the right edge.
  const flip = hover.x > window.innerWidth - 280;
  return (
    <div
      style={{
        position: "fixed",
        left: flip ? hover.x - 270 : hover.x + 14,
        top: Math.min(hover.y + 14, window.innerHeight - 160),
        zIndex: 50,
        maxWidth: 260,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "6px 8px",
        fontSize: 11,
        fontFamily: "monospace",
        color: "var(--text-primary)",
        pointerEvents: "none",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <span style={{ color: KIND_COLORS[s.kind] ?? "#888" }}>{s.kind}</span>{" "}
        <strong>{s.name}</strong> <span style={{ color: "var(--text-muted)" }}>{fmtDur(s.durMs)}</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: "var(--text-muted)" }}>{k}:</span> {v}
        </div>
      ))}
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["turn", "turn"],
    ["agent", "agent"],
    ["api_call", "api call"],
    ["tool", "tool"],
    ["image_gen", "image"],
    ["background", "background"],
  ];
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginLeft: "auto" }}>
      {items.map(([kind, label]) => (
        <span key={kind} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: KIND_COLORS[kind] }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * Segmented flame chart: every turn laid out left→right in chronological order,
 * each turn an independent time-based icicle (depth = nesting, width ∝ duration).
 * Parallel tool calls show as overlapping sibling bars; a subagent shows as a
 * nested agent→api_call subtree. Answers "what took the time in this turn?".
 */
export function TimelineView({
  campaignSlug,
  refreshKey,
}: {
  campaignSlug: string | null;
  refreshKey: number;
}) {
  const { spans, error } = useSpans(campaignSlug, refreshKey);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [hover, setHover] = useState<HoverState>(null);

  const pxPerMs = ZOOM_LEVELS[zoomIndex];
  const segments = useMemo(() => (spans ? buildSegments(spans) : []), [spans]);

  let body: React.ReactNode;
  if (!campaignSlug) {
    body = <div className="timeline-empty">Select a campaign to see its turn timeline.</div>;
  } else if (error) {
    body = <div className="timeline-empty">Failed to load spans: {error}</div>;
  } else if (!spans) {
    body = <div className="timeline-empty">Loading timeline…</div>;
  } else if (segments.length === 0) {
    body = (
      <div className="timeline-empty">
        No spans recorded yet. Spans are written to <code>trace.jsonl</code> during gameplay — play a turn,
        then this view will fill in.
      </div>
    );
  } else {
    body = (
      <div className="timeline-scroll">
        {segments.map((seg) => (
          <div key={seg.turnId} className="timeline-segment">
            <div className="timeline-seg-header" title={new Date(seg.t0).toLocaleString()}>
              {segmentLabel(seg.root)} · {fmtDur(seg.durMs)}
            </div>
            <FlameChart segment={seg} pxPerMs={pxPerMs} onHover={setHover} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <strong>Timeline</strong>
        {segments.length > 0 && <span style={{ color: "var(--text-muted)" }}>{segments.length} turns</span>}
        <button onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0}>−</button>
        <span style={{ color: "var(--text-muted)", minWidth: 56, textAlign: "center" }}>
          {`${(pxPerMs * 1000).toFixed(0)}px/s`}
        </span>
        <button
          onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
        >
          +
        </button>
        <Legend />
      </div>
      {body}
      {hover && <Tooltip hover={hover} />}
    </div>
  );
}
