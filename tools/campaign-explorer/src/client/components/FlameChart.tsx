import type { SpanRecord } from "../../shared/protocol";

/** Row height (px) per nesting depth. */
const ROW_H = 18;

/** Bar fill per span kind. Errors are overdrawn with a red border + tint. */
export const KIND_COLORS: Record<string, string> = {
  turn: "#4fc3f7",       // accent — the player turn envelope
  agent: "#5c6bc0",      // indigo — an agent loop (dm / subagent)
  api_call: "#ab47bc",   // purple — one model round
  tool: "#66bb6a",       // green — a tool call
  image_gen: "#ff7043",  // orange — image generation
  background: "#78909c", // gray — detached background work (suggested choices)
};

const ERROR_COLOR = "#da3633";

/** One turn's worth of spans, grouped and laid out for the chart. */
export interface FlameSegment {
  turnId: number;
  /** The root span (parentId === null): a `turn` or a detached `background`. */
  root: SpanRecord;
  spans: SpanRecord[];
  /** Root start (epoch ms) — segments sort by this. */
  t0: number;
  /** Wall-clock span of the whole turn (ms). */
  durMs: number;
}

/**
 * Group spans by `turnId`, drop any fragment whose root span was tailed off the
 * front of the log window (a group with no `parentId === null` span), and
 * return segments sorted left→right by start time.
 */
export function buildSegments(spans: SpanRecord[]): FlameSegment[] {
  const byTurn = new Map<number, SpanRecord[]>();
  for (const s of spans) {
    const arr = byTurn.get(s.turnId);
    if (arr) arr.push(s);
    else byTurn.set(s.turnId, [s]);
  }

  const segments: FlameSegment[] = [];
  for (const [turnId, group] of byTurn) {
    const root = group.find((s) => s.parentId === null);
    if (!root) continue; // partial turn split across the tail boundary — drop it
    const maxT1 = group.reduce((m, s) => Math.max(m, s.t1), root.t1);
    segments.push({
      turnId,
      root,
      spans: group,
      t0: root.t0,
      durMs: Math.max(root.durMs, maxT1 - root.t0),
    });
  }
  segments.sort((a, b) => a.t0 - b.t0);
  return segments;
}

/** Nesting depth of a span within its segment (0 = root), defensive against a tailed-off ancestor. */
function depthOf(span: SpanRecord, byId: Map<number, SpanRecord>): number {
  let depth = 0;
  let cur = span;
  // Bound the walk by the group size in case of a cycle (shouldn't happen).
  for (let guard = 0; cur.parentId !== null && guard < 64; guard++) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    depth++;
    cur = parent;
  }
  return depth;
}

export type HoverState = { span: SpanRecord; x: number; y: number } | null;

/** Render one turn's flame (time-ordered icicle): x = time offset, y = nesting depth. */
export function FlameChart({
  segment,
  pxPerMs,
  onHover,
}: {
  segment: FlameSegment;
  pxPerMs: number;
  onHover: (h: HoverState) => void;
}) {
  const byId = new Map(segment.spans.map((s) => [s.id, s]));
  const rows = segment.spans.map((s) => ({ s, depth: depthOf(s, byId) }));
  const maxDepth = rows.reduce((m, r) => Math.max(m, r.depth), 0);

  const width = Math.max(2, segment.durMs * pxPerMs);
  const height = (maxDepth + 1) * ROW_H;

  return (
    <div style={{ position: "relative", width, height }}>
      {rows.map(({ s, depth }) => {
        const left = (s.t0 - segment.t0) * pxPerMs;
        const w = Math.max(1, s.durMs * pxPerMs);
        const isError = s.isError === true || s.attrs?.failed === true;
        const fill = KIND_COLORS[s.kind] ?? "#888";
        return (
          <div
            key={s.id}
            onMouseEnter={(e) => onHover({ span: s, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => onHover({ span: s, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => onHover(null)}
            style={{
              position: "absolute",
              left,
              top: depth * ROW_H,
              width: w,
              height: ROW_H - 2,
              background: fill,
              border: isError ? `1px solid ${ERROR_COLOR}` : "1px solid rgba(0,0,0,0.25)",
              boxShadow: isError ? `inset 0 0 0 999px rgba(218,54,51,0.25)` : undefined,
              borderRadius: 2,
              fontSize: 10,
              lineHeight: `${ROW_H - 2}px`,
              color: "rgba(0,0,0,0.85)",
              overflow: "hidden",
              whiteSpace: "nowrap",
              padding: "0 3px",
              boxSizing: "border-box",
              cursor: "default",
            }}
          >
            {w > 34 ? s.name : ""}
          </div>
        );
      })}
    </div>
  );
}
