/**
 * Translate Codex `account/rateLimits/updated` payloads into the generic
 * UsageStatus shape consumed by the Connections UI.
 *
 * Codex emits two windows on every notification — `primary` (5h) and an
 * optional `secondary` (7d). Each window is a percentage-used + reset
 * timestamp. Maps cleanly to two `percentage`-kind segments.
 *
 * Threshold semantics for the `status` field:
 *   < 80%   ok
 *   80–94%  warning
 *   95–99%  critical
 *   ≥ 100%  exceeded
 *
 * These are the same thresholds that emit a `codex:rate_limit:warning`
 * event; raise them by editing `WARNING_THRESHOLD` below.
 */
import type { UsageSegment, UsageSegmentStatus, UsageStatus } from "@machine-violet/shared";
import type { RateLimits, RateLimitWindow } from "./protocol.js";

const WARNING_THRESHOLD = 80;
const CRITICAL_THRESHOLD = 95;
const EXCEEDED_THRESHOLD = 100;

function statusFor(usedPercent: number): UsageSegmentStatus {
  if (usedPercent >= EXCEEDED_THRESHOLD) return "exceeded";
  if (usedPercent >= CRITICAL_THRESHOLD) return "critical";
  if (usedPercent >= WARNING_THRESHOLD) return "warning";
  return "ok";
}

function windowToSegment(
  id: "primary" | "secondary",
  label: string,
  win: RateLimitWindow,
): UsageSegment {
  return {
    id,
    label,
    kind: "percentage",
    usedPercent: win.usedPercent,
    resetsAt: win.resetsAt,
    status: statusFor(win.usedPercent),
    detail: `${win.windowDurationMins}-minute window`,
    liveUpdates: true,
    source: "rpc-notification",
  };
}

/** Convert the most recent `RateLimits` snapshot to a generic `UsageStatus`. */
export function toUsageStatus(limits: RateLimits): UsageStatus {
  const segments: UsageSegment[] = [
    windowToSegment("primary", labelForWindow("primary", limits), limits.primary),
  ];
  if (limits.secondary) {
    segments.push(windowToSegment("secondary", labelForWindow("secondary", limits), limits.secondary));
  }
  return {
    segments,
    snapshotAt: Date.now(),
    fresh: true,
  };
}

function labelForWindow(which: "primary" | "secondary", limits: RateLimits): string {
  // The `limitName` field can be null; fall back to a sensible default
  // based on window duration. As of codex 0.130.0 the windows are 5h
  // (primary) and 7d (secondary) for ChatGPT plans.
  const win = which === "primary" ? limits.primary : limits.secondary;
  if (!win) return which === "primary" ? "Short window" : "Long window";
  const mins = win.windowDurationMins;
  if (mins <= 60) return `${mins}-minute window`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}-hour window`;
  return `${Math.round(mins / (60 * 24))}-day window`;
}

/** Returns true when this snapshot crosses the warning threshold and should fire a log event. */
export function shouldWarn(limits: RateLimits): boolean {
  if (limits.primary.usedPercent >= WARNING_THRESHOLD) return true;
  if (limits.secondary && limits.secondary.usedPercent >= WARNING_THRESHOLD) return true;
  return false;
}
