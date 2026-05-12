/**
 * Provider usage-status schemas.
 *
 * Generic "remaining usage" surface so the UI can render a unified status
 * next to every connection regardless of provider. Each provider that has
 * a quota concept (Codex ChatGPT plan, Anthropic token budgets, OpenAI
 * credit balances) exposes one or more `UsageSegment`s; providers without
 * one (custom Ollama, etc.) just omit the response.
 *
 * Three segment shapes cover the cases:
 *  - "percentage": used%/100, optional resetsAt (Codex 5h + 7d windows)
 *  - "balance":    used/total with unit (USD credits, plan-tier dollars)
 *  - "tokens":     used/total token counts (per-key local budget tracking)
 */
import { Type, type Static } from "@sinclair/typebox";

export const UsageSegmentKind = Type.Union([
  Type.Literal("percentage"),
  Type.Literal("balance"),
  Type.Literal("tokens"),
]);

export const UsageSegmentStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("warning"),
  Type.Literal("critical"),
  Type.Literal("exceeded"),
]);

export const UsageSegment = Type.Object({
  /** Stable identifier within a provider — e.g. "primary", "secondary", "credits". */
  id: Type.String(),
  /** Short human-readable label — e.g. "5-hour window", "Credit balance". */
  label: Type.String(),
  kind: UsageSegmentKind,
  /** Populated when kind === "percentage". 0–100. */
  usedPercent: Type.Optional(Type.Number()),
  /** Populated when kind === "balance" or "tokens". */
  used: Type.Optional(Type.Number()),
  /** Populated when kind === "balance" or "tokens". */
  total: Type.Optional(Type.Number()),
  /** Display unit when applicable — e.g. "USD", "tokens", "%". */
  unit: Type.Optional(Type.String()),
  /** Epoch seconds when this segment's window resets, if it resets at all. */
  resetsAt: Type.Optional(Type.Number()),
  status: UsageSegmentStatus,
  /** Optional free-text annotation (tooltip / aria-label material). */
  detail: Type.Optional(Type.String()),
  /** True when the provider pushes updates (vs poll). Hints richer UI treatment. */
  liveUpdates: Type.Optional(Type.Boolean()),
  /** Where the data came from — for diagnostics in engine.jsonl. */
  source: Type.Optional(Type.Union([
    Type.Literal("request-header"),
    Type.Literal("api"),
    Type.Literal("local-budget"),
    Type.Literal("rpc-notification"),
  ])),
});

export const UsageStatus = Type.Object({
  segments: Type.Array(UsageSegment),
  /** Epoch ms when this snapshot was captured. */
  snapshotAt: Type.Number(),
  /** False when the data is cached / stale (e.g. no successful request yet). */
  fresh: Type.Boolean(),
});

/** Response from `GET /manage/connections/:id/usage`. */
export const UsageResponse = Type.Object({
  /** Connection id this status belongs to. */
  id: Type.String(),
  /** False when the provider has no usage concept (Ollama, custom). */
  available: Type.Boolean(),
  status: Type.Optional(UsageStatus),
});

// --- Static types ---

export type UsageSegmentKind = Static<typeof UsageSegmentKind>;
export type UsageSegmentStatus = Static<typeof UsageSegmentStatus>;
export type UsageSegment = Static<typeof UsageSegment>;
export type UsageStatus = Static<typeof UsageStatus>;
export type UsageResponse = Static<typeof UsageResponse>;
