import type { SegmentRow } from "../lib/render";

interface FrameCanvasProps {
  rows: SegmentRow[];
  caption?: string;
}

/** Render colorized rows as a monospace grid of inline-colored spans. */
export function FrameCanvas({ rows, caption }: FrameCanvasProps) {
  return (
    <div className="canvas">
      {caption && <div className="canvas-caption">{caption}</div>}
      <div className="canvas-grid">
        {rows.map((row, i) => (
          <div key={i} className="canvas-row">
            {row.map((seg, j) => (
              <span key={j} style={seg.color ? { color: seg.color } : undefined}>
                {seg.text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
