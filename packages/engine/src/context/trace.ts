/**
 * Span trace log.
 *
 * Append-only JSONL file at `.debug/trace.jsonl`, a sibling of `engine.jsonl`.
 * Where engine.jsonl is a FLAT event stream, trace.jsonl records a causal
 * TREE: each span carries `id` / `parentId` / `turnId`, so a reader can
 * rebuild the per-turn flame graph — including nested subagents and parallel
 * tool calls, which a flat timestamp stream cannot disambiguate (two
 * `search_campaign` calls in one round are indistinguishable by time alone).
 *
 * Nesting propagates through the async call stack via AsyncLocalStorage:
 * `withSpan` reads the currently-open span (if any) as its parent, opens a
 * child, and runs `fn` inside `als.run`, so everything `fn` awaits — the
 * branches of a `Promise.all`, a nested `runProviderLoop` — sees the child as
 * *their* parent. No ctx parameter is threaded through call sites.
 *
 * Same module-level singleton + synchronous-append pattern as engine-log.ts;
 * see that file's header for why sync `appendFileSync` beats a buffered
 * WriteStream (a live external reader must see lines immediately). A span is
 * one short JSON line written once, on settle.
 *
 * Trace writes are gated on `initTraceLog` having run (server start, non-test
 * only). When the log is uninitialized — unit tests, golden replay —
 * `withSpan` still runs `fn` within the ALS context (so nesting is exercised)
 * but writes nothing, unless a test installs an in-memory sink via
 * `setTraceSink`.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export type SpanKind = "turn" | "agent" | "api_call" | "tool" | "image_gen" | "background";

/** The ALS store: the currently-open span, inherited by everything `fn` awaits. */
export interface SpanContext {
  turnId: number;
  spanId: number;
  campaignId: string;
}

/** One completed span, written as a single JSONL line on settle. */
export interface SpanRecord {
  id: number;
  parentId: number | null;
  turnId: number;
  campaignId: string;
  kind: SpanKind;
  name: string;
  /** epoch ms at open */
  t0: number;
  /** epoch ms at settle */
  t1: number;
  durMs: number;
  /** present (true) only when `fn` threw */
  isError?: boolean;
  /** model, tokens, stopReason, attempts, effort/aspect, … — merged via setSpanAttrs */
  attrs?: Record<string, unknown>;
}

/** Internal ALS value: the public context plus the mutable attrs being accumulated. */
interface ActiveSpan extends SpanContext {
  attrs: Record<string, unknown>;
}

const als = new AsyncLocalStorage<ActiveSpan>();
let logPath: string | null = null;
let spanCounter = 0;
let testSink: ((rec: SpanRecord) => void) | null = null;

/**
 * Initialize the trace log. Called once at server creation, beside
 * `initEngineLog`.
 * @param campaignsDir — the campaigns root; log goes to `../.debug/trace.jsonl`.
 */
export function initTraceLog(campaignsDir: string): void {
  if (logPath) return; // already initialized
  try {
    const debugDir = join(dirname(campaignsDir), ".debug");
    mkdirSync(debugDir, { recursive: true });
    const path = join(debugDir, "trace.jsonl");
    // Touch so an external reader doesn't 404 before the first span lands.
    if (!existsSync(path)) closeSync(openSync(path, "a"));
    logPath = path;
  } catch { /* best-effort */ }
}

/**
 * Reset state (for tests). Resets the monotonic id counter so per-test
 * nesting assertions get deterministic ids (1, 2, 3, …), and clears any
 * installed test sink.
 */
export function resetTraceLog(): void {
  logPath = null;
  spanCounter = 0;
  testSink = null;
}

/** Absolute path of the trace log, or null before init. */
export function getTraceLogPath(): string | null {
  return logPath;
}

/**
 * Test hook: route every settled span to an in-memory sink (in addition to
 * disk, if initialized). Cleared by `resetTraceLog`.
 */
export function setTraceSink(sink: ((rec: SpanRecord) => void) | null): void {
  testSink = sink;
}

/** The currently-open span context, or undefined outside any span. */
export function currentSpan(): SpanContext | undefined {
  return als.getStore();
}

/** Merge attributes into the currently-open span. No-op outside a span. */
export function setSpanAttrs(attrs: Record<string, unknown>): void {
  const store = als.getStore();
  if (store) Object.assign(store.attrs, attrs);
}

function writeSpan(rec: SpanRecord): void {
  testSink?.(rec);
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(rec) + "\n");
  } catch { /* never break the game */ }
}

/**
 * Open a span as a child of the currently-open span (or a fresh root if there
 * is none, or `root: true`), run `fn` within its ALS context, and write the
 * span record on settle — success or throw. A throwing `fn` is recorded with
 * `isError: true` and re-thrown unchanged, so instrumentation never swallows
 * errors.
 *
 * A root span seeds a new `turnId` (= its own id); children inherit the
 * parent's `turnId` and `campaignId`. Provide `campaignId` on the root turn
 * span; nested spans inherit it.
 */
export async function withSpan<T>(
  span: {
    kind: SpanKind;
    name: string;
    campaignId?: string;
    attrs?: Record<string, unknown>;
    /** Detach from any enclosing span and start a fresh trace root. */
    root?: boolean;
  },
  fn: (ctx: SpanContext) => Promise<T>,
): Promise<T> {
  const parent = span.root ? undefined : als.getStore();
  const id = ++spanCounter;
  const active: ActiveSpan = {
    spanId: id,
    turnId: parent ? parent.turnId : id,
    campaignId: span.campaignId ?? parent?.campaignId ?? "",
    attrs: { ...span.attrs },
  };
  const parentId = parent ? parent.spanId : null;
  const t0 = Date.now();
  let isError = false;
  try {
    return await als.run(active, () => fn(active));
  } catch (e) {
    isError = true;
    throw e;
  } finally {
    const t1 = Date.now();
    writeSpan({
      id,
      parentId,
      turnId: active.turnId,
      campaignId: active.campaignId,
      kind: span.kind,
      name: span.name,
      t0,
      t1,
      durMs: t1 - t0,
      ...(isError ? { isError: true } : {}),
      ...(Object.keys(active.attrs).length > 0 ? { attrs: active.attrs } : {}),
    });
  }
}
