import type { UsageSegment } from "@machine-violet/shared";

/** Format a usage segment as one short line (`Weekly: 12% used, resets in 3d`). */
export function formatSegment(seg: UsageSegment): string {
  const reset = seg.resetsAt ? `, resets ${formatRelativeTime(seg.resetsAt)}` : "";
  switch (seg.kind) {
    case "percentage":
      return `${seg.label}: ${formatPercent(seg.usedPercent)}${reset}`;
    case "balance":
      return `${seg.label}: ${formatBalance(seg.used, seg.total, seg.unit)}${reset}`;
    case "tokens":
      return `${seg.label}: ${formatBalance(seg.used, seg.total, seg.unit ?? "tokens")}${reset}`;
  }
}

function formatPercent(p: number | undefined): string {
  if (p === undefined) return "—";
  return `${p.toFixed(p < 10 ? 1 : 0)}% used`;
}

function formatBalance(used: number | undefined, total: number | undefined, unit?: string): string {
  if (used === undefined || total === undefined) return "—";
  const u = unit ?? "";
  const usedStr = unit === "USD" ? `$${used.toFixed(2)}` : `${used.toLocaleString()}${u ? " " + u : ""}`;
  const totalStr = unit === "USD" ? `$${total.toFixed(2)}` : `${total.toLocaleString()}`;
  return `${usedStr} / ${totalStr}`;
}

function formatRelativeTime(epochSec: number): string {
  const deltaSec = epochSec - Math.floor(Date.now() / 1000);
  if (deltaSec <= 0) return "now";
  if (deltaSec < 60) return `in ${deltaSec}s`;
  if (deltaSec < 3600) return `in ${Math.round(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `in ${Math.round(deltaSec / 3600)}h`;
  return `in ${Math.round(deltaSec / 86400)}d`;
}

export function segmentStatusColor(status: UsageSegment["status"]): string {
  switch (status) {
    case "ok": return "#88cc88";
    case "warning": return "#cccc44";
    case "critical": return "#cc8844";
    case "exceeded": return "#cc4444";
  }
}
