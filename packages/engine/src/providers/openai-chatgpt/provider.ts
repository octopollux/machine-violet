/**
 * LLMProvider implementation backed by `codex app-server`.
 *
 * Per-instance lifecycle:
 *   1. Construction is sync and cheap — no subprocess spawned yet.
 *   2. First `chat()` / `stream()` call lazily spawns codex, runs
 *      `initialize`, validates a ChatGPT account is logged in.
 *   3. Each call creates a fresh Codex thread, injects the
 *      caller-supplied history (sans the last user message), kicks off
 *      a turn, runs an internal multi-round tool loop via
 *      `params.dispatchTool`, and returns the final ChatResult.
 *   4. `dispose()` shuts down the subprocess.
 *
 * Why fresh threads per chat() call: the bridge calls chat() with the
 * full normalized history each time. That history is the source of
 * truth — we own it, not Codex. Re-injecting per call keeps the model
 * exactly synced to our scribe/compaction view of the conversation.
 * (Codex's own thread persistence in `~/.codex/sessions/` becomes a
 * harmless second copy.) OpenAI's automatic prompt caching keeps the
 * cost of re-injection cheap on the wire.
 *
 * IMPORTANT: chat() requires `params.dispatchTool` whenever
 * `params.tools` is non-empty. Codex's `item/tool/call` server requests
 * arrive in-band over the JSON-RPC channel and must be replied to
 * synchronously to keep the turn alive. We dispatch the host's tool
 * handler in-process and reply with the result. Providers that don't
 * own tool dispatch (Anthropic, openai-apikey) surface tool calls back
 * to the bridge and let it re-issue chat() — that pattern doesn't
 * translate to Codex's protocol.
 */
import type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedToolCall, NormalizedTool,
  NormalizedUsage, ContentPart, StopReason, SystemBlock,
  ProviderCapabilities, GenerateImageRequest, GenerateImageResult,
  ImageEffort, ImageAspect,
} from "../types.js";
import type { UsageStatus } from "@machine-violet/shared";
import { readFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { CodexRpcClient } from "./rpc.js";
import { StallWatchdog } from "./stall-watchdog.js";
import { getAccount, isChatGptAccount, pushChatGptAuthTokens } from "./auth.js";
import { toUsageStatus, shouldWarn } from "./usage.js";
import { log } from "./log.js";
import { logEvent } from "../../context/engine-log.js";
import { buildReferenceDirective } from "../image-reference-directive.js";
import { getCodexClientInfo } from "./client-info.js";
import type { ChatGptTokenStore, PersistedChatGptTokens } from "./token-store.js";
import type {
  InitializeResult, ThreadStartParams, ThreadStartResult,
  TurnStartParams, UserInputItem, TurnCompletedNotification,
  AgentMessageDeltaNotification, ItemStartedNotification,
  ItemCompletedNotification, ItemBase, TokenUsageUpdatedNotification,
  RateLimitsUpdatedNotification, RateLimits,
  DynamicToolCallParams, DynamicToolCallResponse,
  DynamicToolSpec, ReasoningEffort, ModelListResult,
  ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse,
  RawResponseItemCompletedNotification,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface OpenAIChatGptProviderOptions {
  /** Stable session identifier for log correlation. */
  sessionId?: string;
  /** Working directory passed to thread/start. Cosmetic for our use case. */
  cwd?: string;
  /**
   * Token store backing the chatgptAuthTokens flow. When provided, the
   * provider pushes tokens to codex at startup (refreshing first if
   * expired) and handles codex's `account/chatgptAuthTokens/refresh`
   * server requests by minting new tokens with the stored refresh_token.
   *
   * When absent, the provider falls back to whatever codex has cached in
   * `~/.codex/auth.json` — useful for the env-key codex_cli flow and for
   * tests. Sessions that exceed the access-token lifetime will fail
   * without a token store.
   */
  tokenStore?: ChatGptTokenStore;
}

export function createOpenAIChatGptProvider(opts: OpenAIChatGptProviderOptions = {}): OpenAIChatGptProvider {
  return new OpenAIChatGptProvider(opts);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Per-thread tool-call dispatcher registered by an in-flight `runTurn`.
 * The provider keeps a map keyed by `threadId` so concurrent `chat()`
 * calls (e.g. DM + theme-styler) each receive only their own
 * `item/tool/call` server requests. See {@link OpenAIChatGptProvider}
 * comments around the global `item/tool/call` registration for why we
 * route at the provider level rather than per-call.
 */
type ThreadToolDispatcher = (call: NormalizedToolCall) => Promise<DynamicToolCallResponse>;

export class OpenAIChatGptProvider implements LLMProvider {
  readonly providerId = "openai-chatgpt";

  private rpc: CodexRpcClient | null = null;
  private startPromise: Promise<CodexRpcClient> | null = null;
  private latestRateLimits: RateLimits | null = null;
  private rateLimitListeners = new Set<(s: UsageStatus) => void>();
  private readonly sessionId?: string;
  private readonly cwd: string;
  private readonly tokenStore?: ChatGptTokenStore;
  /**
   * codex's home dir, learned from the `initialize` handshake. The image_gen
   * skill writes every rendered PNG to `<codexHome>/generated_images/<thread
   * sessionId>/` — our reliable, disk-based harvest path when the multi-MB
   * inline-base64 `item/completed` notification is dropped/corrupted on the
   * stdio pipe. Null until the handshake completes. See {@link readRenderedImageFromDisk}.
   */
  private codexHome: string | null = null;
  /**
   * Active per-thread tool dispatchers. Populated by `runTurn` at
   * subscribe time, cleared in its `finally`. The single
   * `item/tool/call` handler installed in `ensureStarted` looks up by
   * `threadId` from the incoming params so concurrent turns can't
   * cross-contaminate. `CodexRpcClient.onServerRequest` only supports
   * one handler per method (last write wins), so we must do the routing
   * ourselves.
   */
  private readonly toolDispatchers = new Map<string, ThreadToolDispatcher>();

  /**
   * Cached `model/list` default-model lookup for `generateImage`. The
   * image-render thread needs *a* model id for `thread/start`, but codex's
   * `image_gen` skill is model-agnostic — the driving model doesn't affect
   * the rendered bytes. We deliberately resolve the account default here
   * rather than reusing the DM's current model: `generateImage` can run
   * concurrently with theme-styler turns on a smaller model, and reading a
   * shared "last model seen" field would race — a styler turn could leave
   * the small model behind and the image would render under it. The account
   * default is stable and never the wrong-tier surprise.
   */
  private defaultModelPromise: Promise<string> | null = null;

  /**
   * Set once we've logged the #597 reasoning tripwire (model reasoned but no
   * `rawResponseItem/completed` reasoning item arrived) for this session. Keeps
   * it a single informational breadcrumb instead of firing on every reasoning
   * turn — which it would, since ChatGPT accounts never emit those raw items
   * (confirmed via live test; #533 codex replay was removed as a no-op, #607).
   * See {@link runTurn}.
   */
  private reasoningGapLogged = false;

  constructor(opts: OpenAIChatGptProviderOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd ?? process.cwd();
    this.tokenStore = opts.tokenStore;
  }

  // -----------------------------------------------------------------------
  // LLMProvider surface
  // -----------------------------------------------------------------------

  getCapabilities(_model: string): ProviderCapabilities {
    // Image gen for ChatGPT-account users routes through codex's built-in
    // `image_gen` skill (gpt-image-2, billed to the ChatGPT plan — no API
    // key). `generateImage` drives a scoped codex turn and harvests the
    // `imageGeneration` item it emits. The skill ships with codex and is
    // available across the gpt-5.x model family, so report true regardless
    // of model — a model that somehow lacked it would simply fail the
    // render turn, surfacing as an isError tool_result the DM can recover
    // from (same as any other generate_image failure).
    return { imageGeneration: true };
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    return this.runTurn(params, undefined);
  }

  async stream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult> {
    return this.runTurn(params, onDelta);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const client = await this.ensureStarted();
      const acct = await getAccount(client);
      if (!acct.account) {
        return { status: "invalid", message: "Not signed in to ChatGPT — run the Sign in flow." };
      }
      if (!isChatGptAccount(acct)) {
        return { status: "invalid", message: `Logged in as ${acct.account.type}; expected chatgpt.` };
      }
      return { status: "valid", message: `Signed in as ${acct.account.email ?? "ChatGPT user"} (${acct.account.planType ?? "unknown plan"})` };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  getUsageStatus(): UsageStatus | null {
    if (!this.latestRateLimits) return null;
    return toUsageStatus(this.latestRateLimits);
  }

  subscribeUsage(cb: (status: UsageStatus) => void): () => void {
    this.rateLimitListeners.add(cb);
    return () => this.rateLimitListeners.delete(cb);
  }

  /** Shut down the subprocess. Called by session-manager at session end. */
  async dispose(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    this.rpc = null;
    this.startPromise = null;
    await rpc.stop();
  }

  /**
   * How long a regular (non-image) codex turn may go COMPLETELY silent — no
   * deltas, items, reasoning, tool calls, or `turn/completed` — before the
   * per-turn stall watchdog gives up and rejects with {@link
   * CodexTurnStalledError}. Generous on purpose: a healthy turn streams
   * reasoning-summary deltas within seconds (we request `summary: "detailed"`),
   * and the watchdog is PAUSED for the whole of any MV tool dispatch (image
   * render, subagent), so this only ever measures codex itself going dark while
   * it owes us a turn. The dominant trigger is codex backing off internally on
   * a persistent rate-limit (429) and never returning — codex is built to run
   * unattended and won't surface that as a failure, so without this the turn
   * hangs until the rate window resets (potentially ~an hour), freezing the
   * game. 120s converts that into a clean, retryable error while sitting far
   * above any plausible quiet stretch of a live turn. (Distinct from the image
   * render cap, which is a flat 10-min give-up on a nested render that is
   * legitimately slow — see {@link IMAGE_RENDER_TIMEOUT_MS}.)
   */
  private static readonly TURN_STALL_TIMEOUT_MS = 120_000;

  // -----------------------------------------------------------------------
  // Image generation
  // -----------------------------------------------------------------------

  /**
   * Give-up cap for a render turn that never reports `turn/completed`. A real
   * gpt-image render (especially `quality`/`showcase`, image-to-image with a
   * reference, or under account contention) routinely runs a few minutes, and
   * codex itself imposes no turn cap by design (it's built to run unattended
   * for a long time) — so this is NOT a render-time budget and must sit well
   * above any legitimate single-image render. At 10 minutes it serves two
   * ends: it's far past any real render, AND past it a waiting player has
   * effectively given up, so it doubles as a sane give-up point. We keep a
   * finite cap rather than waiting forever because the render is a nested turn
   * that pauses the DM turn awaiting our tool reply: with no cap a genuine
   * hang freezes the game with no recovery, whereas hitting this throws an
   * error the dispatcher turns into an isError tool_result the DM degrades
   * from. (The earlier value was 180s, which wrongly killed ordinary slow
   * renders — see the "image render timed out" reports.)
   */
  private static readonly IMAGE_RENDER_TIMEOUT_MS = 10 * 60_000;

  /**
   * Total render attempts before `generateImage` gives up. Retries fire ONLY
   * on {@link ImageGenNoDataError} (a clean turn that emitted no bytes), which
   * a fresh render usually fixes — codex's `image_gen` tool is flaky enough
   * that a single attempt fails a non-trivial fraction of the time even on a
   * quiet account. 3 keeps a good success rate without unbounded latency/cost;
   * a true backend outage still fails (each attempt is independent, so we don't
   * hammer indefinitely). A render-timeout, failed turn, or auth error is NOT
   * retried — see {@link ImageGenNoDataError}.
   */
  private static readonly IMAGE_RENDER_MAX_ATTEMPTS = 3;

  /**
   * Bounded retry for the disk image harvest. codex writes the PNG before the
   * turn completes, so it's normally present the instant we look; these guard
   * only against a filesystem-flush lag on the rare inline-failure path.
   */
  private static readonly DISK_HARVEST_MAX_ATTEMPTS = 3;
  private static readonly DISK_HARVEST_RETRY_MS = 150;

  /**
   * Render one image via codex's built-in `image_gen` skill (gpt-image-2,
   * billed to the ChatGPT plan — no API key). Unlike the openai-apikey
   * provider (a single `images.generate` REST call), there is no direct
   * RPC for image_gen: it's a model-driven tool. So we drive a dedicated,
   * tightly-scoped codex turn whose only job is to call image_gen, then
   * harvest the `imageGeneration` item codex emits — its `result` field
   * carries the raw base64 PNG inline (spike-confirmed on codex 0.133.0).
   *
   * The turn runs `sandbox: "read-only"` + terse instructions so the model
   * can't wander off into shell/file-copy steps (it tried to in the spike;
   * read-only blocks them harmlessly, but we'd rather it not try). Only the
   * `aspect` knob is folded into the prompt text (orientation steering) — the
   * built-in tool takes no explicit size/quality params over the wire, and a
   * live A/B confirmed `effort` can't change render cost/quality here, so it's
   * a no-op on this path (echoed via `effortUsed` for contract parity only).
   * See {@link buildImagePromptText}.
   *
   * Runs as a nested turn on the shared codex subprocess (the DM turn that
   * called generate_image is paused awaiting our tool reply). Codex handles
   * concurrent threads — they're independent tasks over the JSON-RPC pipe —
   * so this doesn't deadlock against the outer turn.
   */
  async generateImage(req: GenerateImageRequest): Promise<GenerateImageResult> {
    const effort: ImageEffort = req.effort ?? "standard";
    const aspect: ImageAspect = req.aspect ?? "square";
    const intent = req.intent ?? "player_request";
    const references = req.referenceImages ?? [];

    logEvent("image_gen:request", {
      provider: this.providerId,
      effort,
      aspect,
      intent,
      ...(references.length > 0 ? { referenceCount: references.length } : {}),
      promptPreview: req.prompt.slice(0, 120),
    });

    const client = await this.ensureStarted();

    const acct = await getAccount(client);
    if (!isChatGptAccount(acct)) {
      throw new Error(
        "openai-chatgpt connection has no active ChatGPT login. " +
        "Run 'Sign in with ChatGPT' from the Connections menu.",
      );
    }

    const model = await this.resolveDefaultModel(client);

    // Bounded retry on the transient "turn completed but emitted no bytes"
    // failure (ImageGenNoDataError) — a fresh render usually fixes it. Every
    // other failure (auth, a failed/interrupted turn, the render-timeout
    // backstop) throws straight out: those don't self-heal on a cheap retry.
    const maxAttempts = OpenAIChatGptProvider.IMAGE_RENDER_MAX_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.renderImageOnce(client, model, { effort, aspect, prompt: req.prompt, references });
      } catch (e) {
        if (shouldRetryImageRender(e, attempt, maxAttempts)) {
          logEvent("image_gen:retry", { provider: this.providerId, effort, aspect, attempt, maxAttempts });
          continue;
        }
        const message = e instanceof Error ? e.message : String(e);
        logEvent("image_gen:error", { provider: this.providerId, effort, aspect, message: message.slice(0, 400) });
        throw e;
      }
    }
  }

  /**
   * One image-render attempt: spin up a throwaway codex thread, kick off the
   * render turn (with any reference images), and harvest the inline bytes.
   * Throws {@link ImageGenNoDataError} when the turn completes cleanly but
   * produces no image — the caller ({@link generateImage}) retries that case.
   */
  private async renderImageOnce(
    client: CodexRpcClient,
    model: string,
    p: {
      effort: ImageEffort;
      aspect: ImageAspect;
      prompt: string;
      references: NonNullable<GenerateImageRequest["referenceImages"]>;
    },
  ): Promise<GenerateImageResult> {
    const { effort, aspect, prompt, references } = p;

    const thread = await client.call<ThreadStartResult>("thread/start", {
      model,
      cwd: this.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: IMAGE_RENDERER_INSTRUCTIONS,
      // Throwaway thread — we harvest the rendered bytes (inline, or off disk
      // from generated_images/<sessionId>/) and discard the thread. Marking it
      // ephemeral keeps codex from persisting session/thread rollout artifacts,
      // which would otherwise pile up fast in the portrait draft loop. (It still
      // writes the generated_images PNG — confirmed — so the disk harvest works.)
      ephemeral: true,
    });
    const threadId = thread.thread.id;
    // codex writes the rendered PNG to <codexHome>/generated_images/<sessionId>/
    // — keyed by the thread's *sessionId*, not its id. This is our reliable
    // disk harvest when the inline-base64 notification is dropped on the pipe.
    const sessionId = thread.thread.sessionId;

    // Harvest the first imageGeneration item that carries bytes. Codex emits
    // it on `item/completed` (status "generating" but `result` already full —
    // see spike). Filter by threadId so a concurrent DM/theme turn can't
    // bleed in.
    // Boxed so the declared union type survives — TS control-flow can't see
    // the closure assignment and would otherwise narrow a bare `let` to never.
    const harvested: { value: { base64: string; revisedPrompt?: string } | null } = { value: null };
    // Inventory of every item the thread emits, so a byteless failure can show
    // exactly what codex produced instead — a refusal `agentMessage`, an
    // `imageGeneration` item with an empty `result`, a different tool call, or
    // nothing at all. This is the difference between "no data" (opaque) and an
    // actual response reason.
    const itemLog: ItemSummary[] = [];
    const unsubItem = client.onNotification<ItemCompletedNotification>(
      "item/completed",
      (p2) => {
        if (p2.threadId !== threadId) return;
        itemLog.push(summarizeItem(p2.item));
        if (harvested.value) return;
        const img = extractGeneratedImage(p2.item);
        if (img) harvested.value = img;
      },
    );

    let completionResolve: ((p2: TurnCompletedNotification) => void) | null = null;
    const completion = new Promise<TurnCompletedNotification>((resolve) => { completionResolve = resolve; });
    const unsubCompleted = client.onNotification<TurnCompletedNotification>(
      "turn/completed",
      (p2) => {
        if (p2.threadId !== threadId) return;
        completionResolve?.(p2);
        completionResolve = null;
      },
    );

    // The render-timeout backstop. Held out here so the `finally` can clear it
    // the instant the race settles — otherwise the timer survives a *successful*
    // render and fires ~10min later, logging a bogus image_gen:timeout and
    // rejecting an already-settled promise. In long-lived gameplay every
    // successful render would leak one, making the timeout signal untrustworthy.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      // Reference images (PC portraits, opt-in per call) ride as `image`
      // input items ahead of the text, so the model sees them as visual
      // references for the named characters. Codex's image_gen then conditions
      // the render on them (image-to-image). data: URLs keep us from writing
      // temp files for the throwaway turn.
      const referenceItems: UserInputItem[] = references.map((r) => ({
        type: "image",
        url: `data:${r.mimeType};base64,${r.base64}`,
      }));
      const labels = references.map((r) => r.label).filter((l): l is string => !!l);
      // NOTE: `effort` is intentionally NOT folded into the prompt here. It's a
      // no-op on this backend (see buildImagePromptText) — the render is a fixed
      // ~1.57 MP at the backend's own `auto` quality regardless of any
      // fidelity/speed wording. It still rides the request (and echoes back via
      // `effortUsed`) to keep the cross-provider GenerateImageRequest contract,
      // and IS honored on the openai-apikey path. Only `aspect` steers here.
      await client.call("turn/start", {
        threadId,
        input: [
          ...referenceItems,
          { type: "text", text: buildImagePromptText(prompt, aspect, labels) },
        ],
        // Lowest reasoning the model needs to call one tool. Summaries off; we
        // don't surface thinking from image turns. NOTE: "low" is the FLOOR
        // here — the backend rejects image_gen at reasoning.effort "minimal"
        // ("The following tools cannot be used with reasoning.effort 'minimal':
        // image_gen, web_search", HTTP 400), which would break ALL renders, not
        // just reference ones. Do not lower this past "low".
        effort: "low",
        summary: "none",
      } satisfies TurnStartParams);

      const completed = await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          const handle = setTimeout(
            () => {
              // Dump whatever arrived before the stall so a timeout is
              // diagnosable too — e.g. an imageGeneration item that started
              // (status "generating") but whose bytes never landed points at a
              // backend/transport hang, not a model that never called the tool.
              logEvent("image_gen:timeout", {
                provider: this.providerId,
                effort,
                aspect,
                timeoutMs: OpenAIChatGptProvider.IMAGE_RENDER_TIMEOUT_MS,
                itemCount: itemLog.length,
                itemTypes: itemLog.map((i) => i.type),
                items: itemLog,
              });
              reject(new Error(
                `image render turn timed out after ${Math.round(OpenAIChatGptProvider.IMAGE_RENDER_TIMEOUT_MS / 1000)}s`,
              ));
            },
            OpenAIChatGptProvider.IMAGE_RENDER_TIMEOUT_MS,
          );
          handle.unref();
          timeoutHandle = handle;
        }),
      ]);

      // Any terminal status other than "completed" (failed, interrupted, or
      // some future status) means the render didn't finish — treat it as an
      // error and surface the actual status so it's debuggable, rather than
      // falling through to the misleading "completed without emitting" below.
      if (completed.turn.status !== "completed") {
        throw new CodexTurnFailedError(
          completed.turn.error?.message ??
            `image render turn ended with status "${completed.turn.status}"`,
          completed.turn.id,
        );
      }

      let captured = harvested.value;

      // Disk fallback: codex always writes the rendered PNG to
      // <codexHome>/generated_images/<sessionId>/ as it generates, *regardless*
      // of whether the inline-base64 bytes survive the stdio pipe. When the
      // inline harvest came up empty (a multi-MB base64 `item/completed` line
      // that was dropped/corrupted on the wire — confirmed: a complete 2 MB PNG
      // lands on disk while our harvest sees nothing), read it straight off
      // disk. The dir is keyed by this ephemeral thread's unique sessionId, so
      // there's no race with concurrent renders. This is the actual fix; the
      // inline path stays as the zero-I/O fast path when it does work.
      if (!captured) {
        const fromDisk = await this.readRenderedImageFromDisk(sessionId);
        if (fromDisk) {
          logEvent("image_gen:disk_recovery", {
            provider: this.providerId,
            effort,
            aspect,
            base64Length: fromDisk.base64.length,
            // The inline notification failed but the file was on disk — this
            // count tells us how often the pipe drops the bytes in practice.
            inlineItemCount: itemLog.length,
            inlineItemTypes: itemLog.map((i) => i.type),
          });
          captured = fromDisk;
        }
      }

      if (!captured) {
        // The turn completed cleanly, no inline bytes, and nothing on disk
        // either. Dump the full inventory of what codex *did* emit — this is the
        // diagnostic that turns an opaque "no data" into an actual reason: a
        // refusal message, an imageGeneration item with an empty result, a
        // different tool call, or an empty turn. Pair with
        // codex:rpc:parse_failure / codex:rpc:large_line to tell a transport
        // drop from a backend no-op.
        const imageItems = itemLog.filter((i) => i.type === "imageGeneration");
        logEvent("image_gen:no_data", {
          provider: this.providerId,
          effort,
          aspect,
          turnStatus: completed.turn.status,
          ...(completed.turn.error?.message ? { turnError: completed.turn.error.message } : {}),
          turnDurationMs: completed.turn.durationMs,
          itemCount: itemLog.length,
          itemTypes: itemLog.map((i) => i.type),
          // Did an imageGeneration item arrive at all, and with what result size?
          // resultLen 0 ⇒ backend produced no bytes; absent ⇒ no item emitted.
          imageItems,
          items: itemLog,
        });
        throw new ImageGenNoDataError("codex image_gen turn completed but produced no image bytes (none inline, none on disk)");
      }

      logEvent("image_gen:response", {
        provider: this.providerId,
        effort,
        aspect,
        base64Length: captured.base64.length,
        ...(captured.revisedPrompt ? { revisedPromptPreview: captured.revisedPrompt.slice(0, 120) } : {}),
      });

      return {
        base64: captured.base64,
        mimeType: "image/png",
        ...(captured.revisedPrompt ? { revisedPrompt: captured.revisedPrompt } : {}),
        effortUsed: effort,
        aspectUsed: aspect,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unsubItem();
      unsubCompleted();
      // Drop codex's per-session render dir. By now we've harvested the bytes
      // (inline or off disk) into `captured` and persist our own copy into the
      // campaign, so codex's <codexHome>/generated_images/<sessionId>/ copy is
      // pure redundancy — 2–3 MB per render that would otherwise accumulate
      // forever (a slow disk leak in a long, image-heavy campaign). The dir is
      // unique to this ephemeral thread, so removing it can't touch any other
      // render. Best-effort and awaited so it's deterministic in tests; a failed
      // cleanup never fails the render (removeGeneratedImageDir swallows errors).
      await this.cleanupGeneratedImageDir(sessionId);
    }
  }

  /**
   * Reliable disk harvest for a rendered image. codex's image_gen skill writes
   * every PNG to `<codexHome>/generated_images/<sessionId>/ig_*.png` as part of
   * the tool call, *before* the turn completes — so by the time we see
   * `turn/completed` the file is fully flushed. Reading it here rescues the
   * render when the inline-base64 `item/completed` notification is dropped or
   * corrupted on the multi-MB stdio line (the observed failure: a complete 2 MB
   * PNG on disk while our harvest saw nothing).
   *
   * The dir is keyed by this ephemeral thread's unique `sessionId`, so the
   * newest PNG in it is unambiguously ours — no race with concurrent renders.
   * Returns null (never throws) if the dir/file isn't there, so the caller
   * falls through to the existing no-data diagnostics.
   */
  private async readRenderedImageFromDisk(
    sessionId: string | undefined,
  ): Promise<{ base64: string } | null> {
    if (!sessionId) return null;
    const dir = this.generatedImageDir(sessionId);
    // codex writes the PNG before the turn completes, so it's normally on disk
    // the instant we look. Retry a few times anyway as cheap insurance against
    // a filesystem-flush lag on the rare failure path (we only get here when the
    // inline harvest already came up empty — a little latency is fine).
    for (let attempt = 0; attempt < OpenAIChatGptProvider.DISK_HARVEST_MAX_ATTEMPTS; attempt++) {
      const got = await readNewestPngAsBase64(dir);
      if (got) return got;
      if (attempt < OpenAIChatGptProvider.DISK_HARVEST_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, OpenAIChatGptProvider.DISK_HARVEST_RETRY_MS).unref());
      }
    }
    return null;
  }

  /**
   * `<codexHome>/generated_images/<sessionId>/` — the per-session dir codex's
   * image_gen skill writes rendered PNGs into. Keyed by sessionId (not thread
   * id) and unique per ephemeral render thread.
   */
  private generatedImageDir(sessionId: string): string {
    const base = this.codexHome ?? join(homedir(), ".codex");
    return join(base, "generated_images", sessionId);
  }

  /**
   * Best-effort removal of this render's per-session dir once the bytes are
   * harvested. See {@link removeGeneratedImageDir} for why it's safe and why we
   * bother. No-op without a sessionId; the dir base mirrors the read path's
   * `codexHome ?? ~/.codex` fallback (`generatedImageDir`), so we always remove
   * exactly the dir we'd have harvested from — including when codexHome was
   * never learned and the read fell back to `~/.codex`.
   */
  private async cleanupGeneratedImageDir(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    await removeGeneratedImageDir(this.generatedImageDir(sessionId));
  }

  /** Lazily resolve + cache the account's default model id for image turns. */
  private resolveDefaultModel(client: CodexRpcClient): Promise<string> {
    if (!this.defaultModelPromise) {
      this.defaultModelPromise = client
        .call<ModelListResult>("model/list", { limit: 50, includeHidden: true })
        .then((r) => r.data.find((m) => m.isDefault)?.id ?? r.data[0]?.id ?? "gpt-5.5")
        .catch(() => "gpt-5.5");
    }
    return this.defaultModelPromise;
  }

  // -----------------------------------------------------------------------
  // Subprocess lifecycle
  // -----------------------------------------------------------------------

  private async ensureStarted(): Promise<CodexRpcClient> {
    if (this.rpc) return this.rpc;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const client = new CodexRpcClient({ sessionId: this.sessionId });
      await client.start();

      const init = await client.call<InitializeResult>("initialize", {
        clientInfo: getCodexClientInfo(),
        capabilities: { experimentalApi: true },
      });
      // codex:subprocess:spawn is already logged by CodexRpcClient.startInternal
      // with the resolved binaryPath. Log a separate `initialized` event here
      // carrying the userAgent / codexHome / platform fields from the
      // handshake response — useful for debugging "which codex are we
      // actually talking to" without re-shadowing the spawn event.
      log.initialized({
        userAgent: init.userAgent,
        codexHome: init.codexHome,
        platformOs: init.platformOs,
        sessionId: this.sessionId,
      });
      // Retain codexHome for the disk-based image harvest (generated_images
      // live under it). Learned only from this handshake.
      if (init.codexHome) this.codexHome = init.codexHome;
      client.notify("initialized", {});

      // Subscribe to rate-limit updates for the lifetime of the subprocess.
      client.onNotification<RateLimitsUpdatedNotification>(
        "account/rateLimits/updated",
        (params) => this.onRateLimitsUpdated(params.rateLimits),
      );

      // Register handler for codex's refresh server requests. Codex sends
      // this when the access_token returns 401 from the backend. We
      // exchange our stored refresh_token for a fresh access_token,
      // persist the new bundle, and reply with the new tokens.
      client.onServerRequest<ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse>(
        "account/chatgptAuthTokens/refresh",
        async (params) => this.handleRefreshRequest(params),
      );

      // Single global handler for `item/tool/call`. Routes to the active
      // per-thread dispatcher in `toolDispatchers`. Registering once at
      // the provider level (rather than once per `runTurn`) is required
      // because `onServerRequest` is single-handler-per-method: a second
      // `runTurn` registration would silently overwrite the first, and
      // the first turn's tool calls would land in the wrong dispatcher.
      // If no dispatcher is registered for a `threadId` (turn already
      // finished, race condition, or codex bug), reply with an error
      // result rather than throwing — the latter would deadlock the
      // turn waiting for a tool reply that never comes.
      client.onServerRequest<DynamicToolCallParams, DynamicToolCallResponse>(
        "item/tool/call",
        async (callParams) => {
          const dispatcher = this.toolDispatchers.get(callParams.threadId);
          if (!dispatcher) {
            return {
              success: false,
              contentItems: [{
                type: "inputText",
                text: `no active tool dispatcher for thread ${callParams.threadId}`,
              }],
            };
          }
          return dispatcher({
            id: callParams.callId,
            name: callParams.tool,
            input: callParams.arguments,
          });
        },
      );

      // If we have stored tokens, hand them to codex now (refreshing first
      // when they're already expired or about to be). Without this codex
      // would either fall back to whatever's in ~/.codex/auth.json or hit
      // an unauthenticated state.
      if (this.tokenStore) {
        await this.pushInitialTokens(client);
      }

      this.rpc = client;
      return client;
    })();

    try {
      return await this.startPromise;
    } catch (err) {
      // Clear so subsequent calls retry from scratch instead of latching onto
      // a rejected promise forever.
      this.startPromise = null;
      this.rpc = null;
      throw err;
    }
  }

  /**
   * Refresh-if-needed, then push the stored tokens into codex via
   * `account/login/start type:"chatgptAuthTokens"`. Called from
   * ensureStarted when a token store is configured.
   */
  private async pushInitialTokens(client: CodexRpcClient): Promise<void> {
    const store = this.tokenStore;
    if (!store) return;
    let tokens = store.load();
    if (!tokens) {
      // No stored tokens — likely an old connection record from before the
      // chatgptAuthTokens flow existed. Let codex fall back to auth.json
      // (or fail at the first call) rather than blocking startup.
      return;
    }
    // 60 seconds of slack so we don't hand codex a token that expires
    // mid-turn. Codex's refresh request handles longer-running drift.
    if (tokens.expiresAtMs <= Date.now() + 60_000) {
      // store.refresh() self-heals the cross-process double-refresh race
      // (it re-reads disk when its own exchange is rejected, adopting a
      // bundle another launch already rotated — see token-store.ts). A
      // throw or null here therefore means the sign-in is genuinely dead,
      // not merely raced. Raise a ChatGptAuthError so classifyServerError
      // drops the session to the main menu rather than into a dead retry
      // overlay (issue #558).
      let refreshed: PersistedChatGptTokens | null;
      try {
        refreshed = await store.refresh();
      } catch (err) {
        throw new ChatGptAuthError(
          "ChatGPT sign-in could not be refreshed; please sign in again in Connections.",
          { cause: err },
        );
      }
      if (!refreshed) {
        throw new ChatGptAuthError(
          "ChatGPT sign-in could not be refreshed; please sign in again in Connections.",
        );
      }
      tokens = refreshed;
    }
    await pushChatGptAuthTokens(client, {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
  }

  /**
   * Handle codex's `account/chatgptAuthTokens/refresh` server request:
   * use the stored refresh_token to mint a new access_token, persist it,
   * and return the new bundle to codex. Coalesces with any concurrent
   * refresh via the token-store mutex (see ChatGptTokenStore.refresh).
   */
  private async handleRefreshRequest(
    _params: ChatgptAuthTokensRefreshParams,
  ): Promise<ChatgptAuthTokensRefreshResponse> {
    const store = this.tokenStore;
    if (!store) {
      throw new Error("Cannot refresh ChatGPT tokens: no token store configured");
    }
    // Pre-check the no-stored-tokens case so codex sees a specific
    // "no stored tokens" message that prompts a sign-in, rather than
    // the generic "rejected by OpenAI" we'd otherwise report. (Both
    // states surface as `refresh()` returning null.)
    if (!store.load()) {
      throw new Error("Cannot refresh ChatGPT tokens: no stored tokens; please sign in again.");
    }
    log.tokenRefresh({ reason: _params.reason, previousAccountId: _params.previousAccountId ?? undefined });
    const fresh = await store.refresh();
    if (!fresh) {
      throw new Error("ChatGPT refresh_token rejected by OpenAI; please sign in again.");
    }
    return {
      accessToken: fresh.accessToken,
      chatgptAccountId: fresh.chatgptAccountId,
      chatgptPlanType: fresh.chatgptPlanType ?? null,
    };
  }

  private onRateLimitsUpdated(limits: RateLimits): void {
    this.latestRateLimits = limits;
    log.rateLimitUpdated({ ...limits });
    if (shouldWarn(limits)) {
      if (limits.primary && limits.primary.usedPercent >= 80) {
        log.rateLimitWarning({
          segmentId: "primary",
          usedPercent: limits.primary.usedPercent,
          resetsAt: limits.primary.resetsAt,
        });
      }
      if (limits.secondary && limits.secondary.usedPercent >= 80) {
        log.rateLimitWarning({
          segmentId: "secondary",
          usedPercent: limits.secondary.usedPercent,
          resetsAt: limits.secondary.resetsAt,
        });
      }
    }
    if (this.rateLimitListeners.size > 0) {
      const status = toUsageStatus(limits);
      for (const cb of this.rateLimitListeners) cb(status);
    }
  }

  // -----------------------------------------------------------------------
  // Turn execution
  // -----------------------------------------------------------------------

  private async runTurn(params: ChatParams, onDelta?: (text: string) => void): Promise<ChatResult> {
    if (params.tools?.length && !params.dispatchTool) {
      throw new Error(
        "openai-chatgpt provider requires params.dispatchTool when params.tools is non-empty " +
        "(Codex tool calls arrive as in-band server requests that must be answered synchronously).",
      );
    }

    const client = await this.ensureStarted();

    // Validate auth before opening a thread — fail fast with a clean error.
    const acct = await getAccount(client);
    if (!isChatGptAccount(acct)) {
      throw new Error(
        "openai-chatgpt connection has no active ChatGPT login. " +
        "Run 'Sign in with ChatGPT' from the Connections menu.",
      );
    }

    // Split history: everything before the final user message goes via
    // thread/inject_items; the final user message becomes turn input.
    // If there is no trailing user message (unusual — caller misuse),
    // we still have to feed turn/start something, so synthesize an empty
    // text input rather than crash.
    const { historyToInject, lastUserText } = splitHistoryAndUserInput(params.messages);

    // Build the developer instructions from systemPrompt blocks.
    const developerInstructions = systemPromptToString(params.systemPrompt);

    // Convert tools to DynamicToolSpec.
    const dynamicTools: DynamicToolSpec[] | undefined = params.tools?.length
      ? params.tools.map(toolToDynamicSpec)
      : undefined;

    const startParams = buildThreadStartParams({
      model: params.model,
      developerInstructions,
      // Replace codex's built-in coding-agent base prompt. None of MV's codex
      // chat agents are coding agents, and that base persona ("you are Codex …
      // follow safety, tool, and workspace constraints") leaks into the DM —
      // it self-identifies as Codex and skews deferential/conservative. The
      // helper defaults this to "" (strip it entirely) so the agent runs on
      // developerInstructions alone; a caller can still pass an explicit base.
      // Verified on gpt-5.5: accepted (no HTTP 400), strips the Codex identity,
      // tool dispatch intact. The image-render turn is a SEPARATE thread/start
      // (renderImageOnce) and is not touched by this — it keeps codex's default
      // base + image_gen scaffolding. Probe: test-harness/bin/codex-base-instructions.ts.
      baseInstructions: params.baseInstructions,
      dynamicTools,
      cwd: this.cwd,
    });

    const thread = await client.call<ThreadStartResult>("thread/start", startParams);
    const threadId = thread.thread.id;
    log.threadStart({ threadId, model: params.model, sessionId: this.sessionId });

    // Inject prior history if any.
    if (historyToInject.length > 0) {
      await client.call("thread/inject_items", {
        threadId,
        items: historyToInject,
      });
    }

    // Subscribe to per-turn notifications BEFORE issuing turn/start.
    //
    // CRITICAL: every handler must filter by `threadId`. The codex
    // subprocess is shared across all concurrent `chat()` calls on this
    // provider — e.g. DM (gpt-5.5) and theme-styler (gpt-5.4-mini) run
    // simultaneously during a normal turn. The RPC client broadcasts each
    // notification to every subscriber, so without this guard each
    // TurnCollector would harvest deltas, tool calls, and completion
    // events from the *other* turn, producing duplicated/spliced
    // assistant output and resolving `completion` on the wrong turn.
    const collected = new TurnCollector(onDelta);
    const forThisThread = (p: { threadId: string }): boolean => p.threadId === threadId;

    // --- Turn completion future + tool-aware stall watchdog ---
    // `completion` resolves on `turn/completed` FOR THIS THREAD ONLY (see the
    // thread-filter rationale above). Two things can stop it ever resolving and
    // freeze the game on `await completion` below; both are converted into a
    // thrown error instead of an unbounded hang:
    //   1. The subprocess dies mid-turn (handled by onSubprocessExit, below).
    //   2. codex stays ALIVE but goes completely silent — the usual cause is
    //      codex backing off internally on a persistent rate-limit (429) and
    //      retrying for minutes, emitting no deltas, items, reasoning, tool
    //      calls, or completion. The watchdog below catches that.
    // The watchdog re-arms on ANY codex notification for this thread (that's
    // `watchdog.note()` on each handler) and is PAUSED for the full duration of
    // every MV tool dispatch — an image render legitimately runs minutes and a
    // subagent tens of seconds, during which codex is correctly idle awaiting
    // our tool_result, so counting that as a stall would kill healthy turns. A
    // depth counter (not a flag) keeps the pause correct under concurrent tool
    // calls. So the only thing it ultimately measures is codex itself going
    // dark while it owes us a turn.
    let completionResolve: ((p: TurnCompletedNotification) => void) | null = null;
    let completionReject: ((e: Error) => void) | null = null;
    const settleCompletion = (): void => {
      completionResolve = null;
      completionReject = null;
    };
    const watchdog = new StallWatchdog(
      OpenAIChatGptProvider.TURN_STALL_TIMEOUT_MS,
      () => {
        completionReject?.(new CodexTurnStalledError(OpenAIChatGptProvider.TURN_STALL_TIMEOUT_MS, threadId));
        settleCompletion();
      },
    );

    const unsubAgentDelta = client.onNotification<AgentMessageDeltaNotification>(
      "item/agentMessage/delta",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onAgentMessageDelta(p); },
    );
    const unsubItemStarted = client.onNotification<ItemStartedNotification>(
      "item/started",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onItemStarted(p); },
    );
    const unsubItemCompleted = client.onNotification<ItemCompletedNotification>(
      "item/completed",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onItemCompleted(p); },
    );
    const unsubReasoning = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/textDelta",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onReasoningDelta(p); },
    );
    const unsubReasoningSummary = client.onNotification<AgentMessageDeltaNotification>(
      "item/reasoning/summaryTextDelta",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onReasoningDelta(p); },
    );
    // We subscribe to `rawResponseItem/completed` for the #597 tripwire only —
    // NOT to capture reasoning for replay. codex emits no usable encrypted
    // reasoning blob on the ChatGPT-account path, so #533 codex replay was a
    // no-op and was removed (#607). The handler just counts reasoning items so
    // we can tell "model reasoned but none arrived" (the steady state here)
    // from a future account type that does emit them.
    const unsubRawItem = client.onNotification<RawResponseItemCompletedNotification>(
      "rawResponseItem/completed",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onRawResponseItem(p); },
    );
    const unsubTokenUsage = client.onNotification<TokenUsageUpdatedNotification>(
      "thread/tokenUsage/updated",
      (p) => { if (!forThisThread(p)) return; watchdog.note(); collected.onTokenUsage(p); },
    );

    // Tool dispatch: install a per-thread dispatcher into the provider's
    // routing map. The global `item/tool/call` handler registered in
    // `ensureStarted` looks us up by `threadId` and forwards. Replies
    // must use the strict Codex shape:
    //   { success: boolean, contentItems: [{type:"inputText", text}] }
    const dispatchForThread: ThreadToolDispatcher = async (call) => {
      collected.onToolCall(call);
      watchdog.note();
      const dispatcher = params.dispatchTool;
      if (!dispatcher) {
        // Should be unreachable — we guarded above when tools is set.
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "no dispatchTool configured" }],
        };
      }
      // Pause the stall watchdog for the whole dispatch: a tool call (image
      // render up to ~10 min, a subagent, etc.) legitimately runs long while
      // codex sits idle awaiting our reply, and that idleness must not read as
      // a wedged turn.
      watchdog.enterToolDispatch();
      try {
        const result = await dispatcher(call);
        return {
          success: !result.isError,
          contentItems: [{ type: "inputText", text: result.content }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          contentItems: [{ type: "inputText", text: `tool dispatch failed: ${msg}` }],
        };
      } finally {
        watchdog.exitToolDispatch();
      }
    };
    this.toolDispatchers.set(threadId, dispatchForThread);
    const unsubToolCall = (): void => { this.toolDispatchers.delete(threadId); };

    // Turn completion future — resolves on `turn/completed` notification FOR
    // THIS THREAD ONLY (see thread-filter rationale above). State + watchdog
    // helpers were declared with the stall-watchdog block above.
    const completion = new Promise<TurnCompletedNotification>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    // `completion` can be REJECTED before control reaches `await completion`
    // below: the onSubprocessExit handler (registered just under) fires if
    // codex dies while `turn/start` is still in-flight, and that `call()` will
    // reject first, throwing us straight to `finally` without ever awaiting
    // `completion`. A rejected promise with no handler trips Node's
    // unhandled-rejection path. Attach a no-op rejection handler so it's always
    // considered handled; the real awaiter below still observes the rejection
    // (a promise can carry many handlers), and on the normal path this never
    // fires because `completion` resolves.
    void completion.catch(() => { /* observed by the awaiter below; this only marks it handled */ });
    const unsubCompleted = client.onNotification<TurnCompletedNotification>(
      "turn/completed",
      (p) => {
        if (!forThisThread(p)) return;
        completionResolve?.(p);
        settleCompletion();
      },
    );
    // If the codex subprocess dies *after* `turn/start` has returned, the
    // pending-call rejection in rpc.ts — which only covers in-flight `call()`s
    // — never touches this promise, so `turn/completed` can't arrive and
    // `await completion` below would hang forever, freezing the game with no
    // recovery. Reject the instant the subprocess exits so a mid-turn codex
    // death surfaces as a turn error instead of an unkillable hang. (This is
    // one of the two ways a codex turn can wedge — subprocess gone. The other,
    // subprocess alive but stalled, e.g. codex backing off on a 429, is not
    // covered here.)
    const onSubprocessExit = (info: { code: number | null; signal: string | null }): void => {
      completionReject?.(new Error(`codex app-server exited mid-turn (code=${info.code} signal=${info.signal})`));
      settleCompletion();
    };
    client.once("exit", onSubprocessExit);

    try {
      // Empty `lastUserText` means we're resuming from history alone
      // (e.g. after resolveChoice pushed a tool_result for a
      // suspending-tool flow like present_choices). Counter-intuitively
      // codex no-ops `turn/start` when `input: []` — the RPC returns a
      // turn id but no task ever starts, so notifications stop arriving
      // and the call hangs forever. We must hand it a non-empty input.
      //
      // We can't avoid this by skipping the function_call_output from
      // injection either: the Responses API requires `function_call` to
      // be paired with `function_call_output`, so the items must stay.
      // Instead we pass a tiny continuation cue. The model treats it as
      // a benign user prompt and generates its next response from the
      // injected tool result.
      const turnInput: TurnStartParams["input"] = lastUserText
        ? [{ type: "text", text: lastUserText }]
        : [{ type: "text", text: "(continue)" }];
      // Request detailed reasoning summaries whenever we're asking for any
      // reasoning effort. Without this, codex defaults to summary="none" for
      // chatgpt-account flows and our thinkingText never gets populated even
      // though reasoning tokens are billed — see protocol.ts:TurnStartParams.
      const turnReq: TurnStartParams = {
        threadId,
        input: turnInput,
        ...(params.thinking?.effort
          ? {
              effort: mapEffort(params.thinking.effort),
              summary: "detailed",
            }
          : {}),
      };
      log.turnStart({ threadId, effort: turnReq.effort });
      const turnStart = await client.call<{ turn: { id: string } }>("turn/start", turnReq);
      const turnId = turnStart.turn.id;

      // Arm the stall watchdog now that the turn is running. A turn that goes
      // silent from the very first instant (e.g. codex hits a 429 before
      // emitting anything) produces no notifications to re-arm it, so the
      // initial arm here is what bounds that case; subsequent codex activity
      // resets it via watchdog.note().
      watchdog.note();

      const completed = await completion;
      const errorMessage = completed.turn.error?.message ?? null;
      log.turnComplete({
        threadId,
        turnId,
        durationMs: completed.turn.durationMs,
        status: completed.turn.status,
        error: errorMessage,
      });

      // A failed Codex turn is a system-level failure (model-not-found,
      // auth, rate limit, tools schema mismatch, etc), not a content
      // refusal. Surface the reason instead of returning empty text —
      // callers like setup-conversation don't check stopReason and would
      // otherwise render nothing.
      if (completed.turn.status === "failed") {
        throw new CodexTurnFailedError(errorMessage ?? "(no error message from codex)", turnId);
      }

      // #597 tripwire. If the model demonstrably reasoned (summary deltas
      // streamed) but NOT ONE raw reasoning item arrived on
      // `rawResponseItem/completed`, there was no encrypted blob with which to
      // preserve cross-turn chain-of-thought this turn. On a ChatGPT account
      // this is the norm, not an error: a live test confirmed codex emits no
      // raw reasoning items there at all, so the #533 codex replay was a no-op
      // and has been removed (#607). We keep this breadcrumb as a tripwire — if
      // raw reasoning items ever DO start arriving (a ZDR/enterprise login, an
      // upstream codex change) it stops firing, and that's the signal to
      // reconsider replay. A genuine *intermittent* transport drop instead
      // shows up reliably as a `parse_failure` with `methodGuess`. Logged ONCE
      // per session (else it fires on every reasoning turn for every account).
      const rstats = collected.reasoningCaptureStats();
      if (!this.reasoningGapLogged && rstats.summaryDeltas > 0 && rstats.rawReasoningItems === 0) {
        this.reasoningGapLogged = true;
        log.reasoningRawItemMissing({
          threadId,
          turnId,
          summaryDeltas: rstats.summaryDeltas,
          sessionId: this.sessionId,
        });
      }

      return collected.toChatResult(completed);
    } finally {
      unsubAgentDelta();
      unsubItemStarted();
      unsubItemCompleted();
      unsubReasoning();
      unsubReasoningSummary();
      unsubRawItem();
      unsubTokenUsage();
      unsubToolCall();
      unsubCompleted();
      client.off("exit", onSubprocessExit);
      watchdog.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function systemPromptToString(systemPrompt: string | SystemBlock[]): string {
  if (typeof systemPrompt === "string") return systemPrompt;
  return systemPrompt.map((b) => b.text).join("\n\n");
}

/**
 * Build the `thread/start` params for a DM/subagent chat turn. Extracted as a
 * pure function so the wiring is unit-testable without spinning up codex.
 *
 * `baseInstructions` defaults to `""` — this REPLACES codex's built-in
 * coding-agent base prompt. None of MV's codex chat agents are coding agents,
 * and that base persona ("you are Codex … follow safety, tool, and workspace
 * constraints") otherwise leaks into the DM (it self-identifies as Codex and
 * skews deferential/conservative). A caller can pass an explicit base to
 * override. Verified on gpt-5.5: accepted (no HTTP 400), strips the Codex
 * identity, tool dispatch intact. The image-render turn is a SEPARATE
 * `thread/start` (`renderImageOnce`) and does NOT use this — it keeps codex's
 * default base + image_gen scaffolding. Probe: `test-harness/bin/codex-base-instructions.ts`.
 */
export function buildThreadStartParams(opts: {
  model: string;
  developerInstructions: string;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  cwd: string;
}): ThreadStartParams {
  return {
    model: opts.model,
    developerInstructions: opts.developerInstructions,
    baseInstructions: opts.baseInstructions ?? "",
    ...(opts.dynamicTools ? { dynamicTools: opts.dynamicTools } : {}),
    cwd: opts.cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
  };
}

/**
 * Developer instructions for the scoped image-render turn. Keeps the model on
 * rails: its one job is to call image_gen once — no shell, no file ops, no
 * prose, and (for the reference path) no *analyzing* the attached images.
 *
 * Two failure modes this defends against:
 *  - Without the no-shell rails the model treats the request like a coding task
 *    — in the spike it read SKILL.md and tried `Copy-Item`/`Get-ChildItem` to
 *    "save" the file (blocked by read-only sandbox, but wasted tokens/latency).
 *  - When a reference image is attached, telling the model to "match the
 *    character's face to the reference" makes it think *it* must study and
 *    describe the picture — so it spends a long reasoning pass on vision
 *    analysis and then replies with text instead of calling image_gen at all
 *    (observed: ~200s wasted, the turn rescued only by the caller's retry). The
 *    matching is image_gen's job, and the per-character match directive already
 *    rides in the prompt text via buildImagePromptText — so here we tell the
 *    model the opposite: the references are consumed automatically, don't look
 *    at them, just call the tool.
 */
const IMAGE_RENDERER_INSTRUCTIONS =
  "You are a silent image-rendering backend. The user message is an image " +
  "description, optionally preceded by one or more reference images. Your only " +
  "job is to call the built-in image_gen tool exactly once with that description. " +
  "Any reference images are consumed by image_gen automatically — you do NOT need " +
  "to view, analyze, describe, or reason about them; the description already names " +
  "which character each one depicts. Do NOT run shell commands. Do NOT save, copy, " +
  "move, or list files — the caller harvests the rendered bytes directly. Do NOT " +
  "write any explanatory prose, captions, or follow-up. Render the image and stop.";

/**
 * Orientation steering — the ONE render knob that actually works on this
 * backend. The built-in image_gen tool takes no explicit size/quality params
 * (codex sends the hosted `image_generation` tool bare → backend `auto`), so
 * the only lever is the prompt text, and orientation is the only thing it moves
 * reliably: a live A/B (2026-06-22) showed `landscape` → 1536×1024 and `square`
 * → 1254×1254, i.e. the backend honors the *shape* but renders a FIXED ~1.57 MP
 * budget either way. So `aspect` reshapes the pixel layout; it does not change
 * the pixel count (or cost). See docs/image-generation.md (Provider backends).
 */
const ASPECT_GUIDANCE: Record<ImageAspect, string> = {
  portrait: "Use a tall vertical portrait orientation (roughly 1024x1536).",
  landscape: "Use a wide landscape orientation (roughly 1536x1024).",
  square: "Use a square 1:1 orientation (roughly 1024x1024).",
};

// Why there's NO effort/quality steering folded into the codex render prompt:
// the built-in image_gen tool exposes no quality/size param (confirmed against
// codex 0.133–0.142; upstream openai/codex#20839 is open with no fix), and the
// hosted tool's quality is request-level config codex sends bare → the backend
// renders at its own `auto` quality regardless of any wording. A live A/B
// (2026-06-22) confirmed prompt fidelity/speed language does NOT reliably change
// render time, pixel count, or plan-usage cost — it only nudges how *detailed*
// the image looks (a content/aesthetic effect, not a cost dial), and the old
// "do NOT engage the slowest pass" wording was premised on a quality control
// that doesn't exist here. So `effort` is a documented NO-OP on this path: it
// rides the request and echoes via `effortUsed` for the cross-provider
// GenerateImageRequest contract (and IS real on openai-apikey), but never
// reaches the render. There is intentionally no EFFORT_GUIDANCE constant.

/**
 * Retry policy for {@link OpenAIChatGptProvider.generateImage}: retry iff the
 * failure is a transient {@link ImageGenNoDataError} (clean turn, no bytes)
 * AND we have attempts left. Every other failure — auth, a failed/interrupted
 * turn, the render-timeout backstop — is terminal. Pure + exported so the
 * policy is unit-tested without driving a live codex turn.
 */
export function shouldRetryImageRender(error: unknown, attempt: number, maxAttempts: number): boolean {
  return error instanceof ImageGenNoDataError && attempt < maxAttempts;
}

/**
 * Fold the working knob (`aspect`) into the prompt text. The built-in image_gen
 * tool accepts no explicit size/quality params over the RPC, so orientation is
 * steered in natural language via {@link ASPECT_GUIDANCE}. The `effort` knob is
 * deliberately NOT steered here — it's a no-op on this backend (see the comment
 * above {@link ASPECT_GUIDANCE} and on the call site in {@link renderImageOnce}).
 *
 * When `referenceLabels` is non-empty, a directive naming the referenced
 * characters is appended so the model knows the attached images are
 * appearance references for those names (the images themselves ride as
 * separate `image` input items on the turn — see {@link generateImage}).
 *
 * Exported for unit tests.
 */
export function buildImagePromptText(
  prompt: string,
  aspect: ImageAspect,
  referenceLabels: string[] = [],
): string {
  return `${ASPECT_GUIDANCE[aspect]} ${prompt}${buildReferenceDirective(referenceLabels)}`;
}

/**
 * Extract image bytes from an `item/completed` payload, if it's a populated
 * `imageGeneration` item. Returns null for any other item type or an
 * imageGeneration item that hasn't produced bytes yet (the `item/started`
 * placeholder has `result: ""`). Spike-confirmed: codex emits the bytes on
 * `item/completed` with `status: "generating"` but `result` already full, so
 * we key off a non-empty `result` rather than the status string.
 *
 * Exported for unit tests.
 */
export function extractGeneratedImage(item: ItemBase): { base64: string; revisedPrompt?: string } | null {
  if (item.type !== "imageGeneration") return null;
  if (typeof item.result !== "string" || item.result.length === 0) return null;
  return {
    base64: item.result,
    ...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {}),
  };
}

/**
 * Read the newest `*.png` in a directory and return it base64-encoded, or null
 * if the dir is absent/empty/unreadable (never throws). This is the core of the
 * disk-based image harvest: codex writes rendered PNGs to a per-session dir, and
 * the newest one is the render we just kicked off. Exported for unit tests.
 */
export async function readNewestPngAsBase64(dir: string): Promise<{ base64: string } | null> {
  try {
    const entries = await readdir(dir);
    const pngs = entries.filter((e) => e.toLowerCase().endsWith(".png"));
    if (pngs.length === 0) return null;
    // Newest by mtime — a single render writes one file, but be defensive.
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const name of pngs) {
      const full = join(dir, name);
      try {
        const st = await stat(full);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: st.mtimeMs };
      } catch {
        // Vanished between readdir and stat — ignore.
      }
    }
    if (!newest) return null;
    const bytes = await readFile(newest.path);
    if (bytes.length === 0) return null;
    return { base64: bytes.toString("base64") };
  } catch {
    // Dir missing (no image was written) or unreadable — not recoverable here.
    return null;
  }
}

/**
 * Best-effort, never-throws removal of a codex per-session render dir
 * (`<codexHome>/generated_images/<sessionId>/`). We harvest the rendered bytes
 * (inline or off disk via {@link readNewestPngAsBase64}) and persist our own
 * copy into the campaign, so codex's copy is pure redundancy — ~2–3 MB per
 * render that otherwise accumulates forever. The dir is unique to one ephemeral
 * render thread, so removing it can't affect any other render. A failed cleanup
 * must never fail the render, so all errors are swallowed. Exported for tests.
 */
export async function removeGeneratedImageDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // A leftover redundant PNG is harmless; failing the render over cleanup is not.
  }
}

/** Compact, log-safe summary of a thread item — never carries raw image bytes. */
export interface ItemSummary {
  type: string;
  status?: string;
  /**
   * For imageGeneration items: character length of the base64 `result` string
   * (~4/3 of the decoded byte size) — a proxy for image size, not a decoded
   * byte count. 0 ⇒ the item carried no bytes (backend emitted no image).
   */
  resultLen?: number;
  /** For text-bearing items (agentMessage, reasoning): a short preview to catch refusals. */
  textPreview?: string;
  /** For tool calls: which tool, and whether it reported success. */
  tool?: string;
  success?: boolean;
}

/**
 * Reduce a thread {@link ItemBase} to a small, log-safe shape. Critically it
 * records `result.length` for imageGeneration items (so a byteless render shows
 * `resultLen: 0` rather than just vanishing) and a text preview for messages
 * (so a model refusal surfaces as the actual response reason) — without ever
 * copying multi-MB base64 into the log. Exported for unit tests.
 */
export function summarizeItem(item: ItemBase): ItemSummary {
  const s: ItemSummary = { type: item.type };
  if (typeof item.status === "string") s.status = item.status;
  if (item.type === "imageGeneration") {
    s.resultLen = typeof item.result === "string" ? item.result.length : 0;
  }
  if (typeof item.text === "string" && item.text.length > 0) {
    s.textPreview = item.text.slice(0, 200);
  }
  if (typeof item.tool === "string") s.tool = item.tool;
  if (typeof item.success === "boolean") s.success = item.success;
  return s;
}

function toolToDynamicSpec(tool: NormalizedTool): DynamicToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function mapEffort(effort: "low" | "medium" | "high" | "max" | null): ReasoningEffort {
  if (effort === "max") return "xhigh";
  if (effort === null) return "minimal";
  return effort;
}

interface SplitHistory {
  historyToInject: unknown[];
  lastUserText: string;
}

/**
 * Convert NormalizedMessage[] → Responses-API items + extract last user text.
 *
 * Codex `thread/inject_items` accepts raw Responses-API items. Assistant
 * tool_use blocks become `function_call` items; user tool_result blocks
 * become `function_call_output` items; plain text becomes `message` items.
 *
 * Turn input strategy depends on what the trailing message looks like:
 *
 * - **Trailing user message is pure text** — that's a fresh user turn.
 *   Use its text as `turn/start` input; inject everything before it as
 *   history.
 * - **Trailing user message contains tool_result blocks** — we're
 *   resuming after an inter-round tool dispatch (e.g. setup's
 *   `present_choices` → player picked → resolveChoice pushes
 *   `tool_result` and re-enters the loop). Inject the ENTIRE history,
 *   including the tool_result message, and pass empty turn input. Codex
 *   reads the function_call_output items and continues the conversation
 *   without needing a new user message.
 * - **Trailing message is assistant** (model emitted text and we haven't
 *   asked again) — same as the tool_result case: inject everything,
 *   empty input.
 *
 * Empty turn input is supported by codex — it runs a turn against
 * whatever context is present in the thread.
 */
function splitHistoryAndUserInput(messages: NormalizedMessage[]): SplitHistory {
  // Find the LAST user message (don't walk past it — its shape decides
  // the turn-input strategy).
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Is that message a fresh user turn (pure text), or inter-round tool
  // plumbing? Pure text → use as turn input; otherwise → inject as history.
  let useAsTurnInput = false;
  if (lastUserIdx >= 0) {
    const m = messages[lastUserIdx];
    useAsTurnInput = typeof m.content === "string"
      || m.content.every((p) => p.type === "text");
  }

  const items: unknown[] = [];
  const toInject = useAsTurnInput ? messages.slice(0, lastUserIdx) : messages;
  for (const msg of toInject) {
    items.push(...messageToResponsesItems(msg));
  }
  const interleaved = interleaveCallsAndOutputs(items);

  let lastUserText = "";
  if (useAsTurnInput && lastUserIdx >= 0) {
    const m = messages[lastUserIdx];
    if (typeof m.content === "string") {
      lastUserText = m.content;
    } else {
      lastUserText = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
    }
  }

  return { historyToInject: interleaved, lastUserText };
}

/**
 * Reorder a flat Responses-API item list so each `function_call` is
 * immediately followed by its matching `function_call_output`.
 *
 * Why this exists: our normalized history groups all tool_use blocks
 * under one assistant message and all tool_result blocks under the next
 * user message. Naive conversion yields
 *   function_call(A), function_call(B), function_call_output(A), function_call_output(B)
 * which the Responses API rejects — it requires strict immediate pairing.
 *
 * Outputs that match nothing are dropped (orphan results indicate
 * upstream state corruption; passing them through would just provoke a
 * different API error). Calls that match nothing pass through as-is and
 * will trigger a "missing output" error from codex/OpenAI — preferable
 * to a silent hang.
 */
function interleaveCallsAndOutputs(items: unknown[]): unknown[] {
  interface Item { type?: string; call_id?: string }
  // Index every function_call_output by its call_id, and remember which
  // index it sits at so we can skip it during the main pass.
  const outputByCallId = new Map<string, unknown>();
  const consumedOutputIndices = new Set<number>();
  items.forEach((raw, idx) => {
    const it = raw as Item;
    if (it.type === "function_call_output" && typeof it.call_id === "string") {
      outputByCallId.set(it.call_id, raw);
      consumedOutputIndices.add(idx);
    }
  });

  const result: unknown[] = [];
  const placedCallIds = new Set<string>();
  items.forEach((raw, idx) => {
    if (consumedOutputIndices.has(idx)) return;
    const it = raw as Item;
    result.push(raw);
    if (it.type === "function_call" && typeof it.call_id === "string") {
      const output = outputByCallId.get(it.call_id);
      if (output && !placedCallIds.has(it.call_id)) {
        result.push(output);
        placedCallIds.add(it.call_id);
      }
    }
  });
  return result;
}

/**
 * Convert one normalized message to one or more Responses-API items.
 *
 * Mirrors the converter in providers/openai.ts (toResponsesInput) but is
 * duplicated here rather than exported to keep cross-module coupling
 * minimal — the openai.ts version is keyed to a slightly different
 * SystemBlock convention. If they diverge meaningfully in the future,
 * extract to providers/openai-shared.ts.
 *
 * Exported for unit tests — production callers go through
 * `splitHistoryAndUserInput`.
 */
export function messageToResponsesItems(msg: NormalizedMessage): unknown[] {
  // Codex's Responses-API deserializer is stricter than the OpenAI SDK:
  // `message.content` MUST be a sequence of typed content parts, never a
  // bare string. User text → `input_text`, assistant text → `output_text`.
  // Sending a raw string yields:
  //   "items[0] is not a valid response item: invalid type: string ...,
  //    expected a sequence"
  // and aborts the turn. Always wrap.
  const userPart = (text: string) => ({ type: "input_text", text });
  const asstPart = (text: string) => ({ type: "output_text", text });

  if (typeof msg.content === "string") {
    const part = msg.role === "user" ? userPart(msg.content) : asstPart(msg.content);
    return [{ type: "message", role: msg.role, content: [part] }];
  }

  if (msg.role === "assistant") {
    const items: unknown[] = [];

    // We emit no reasoning items on this provider. codex surfaces no usable
    // encrypted reasoning blob on the ChatGPT-account path, so we never capture
    // one to replay — the #533 codex replay was a no-op and was removed (#607).
    // A `reasoning` part therefore can't originate here; the only way one
    // reaches this function is a mid-campaign connection switch from the
    // openai-apikey Responses path, and codex would reject that foreign blob on
    // input — so we drop it (handled in the loop below, alongside the Anthropic
    // `thinking`/`redacted_thinking` blocks).
    let pendingText = "";
    for (const part of msg.content) {
      if (part.type === "text") {
        pendingText += part.text;
      } else if (part.type === "tool_use") {
        if (pendingText) {
          items.push({ type: "message", role: "assistant", content: [asstPart(pendingText)] });
          pendingText = "";
        }
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      }
      // reasoning (a foreign openai-apikey blob) and thinking/redacted_thinking
      // (Anthropic-shape) are all dropped — codex rejects them on input. See
      // the header comment on this branch.
    }
    if (pendingText) {
      items.push({ type: "message", role: "assistant", content: [asstPart(pendingText)] });
    }
    return items;
  }

  // user message with array content. tool_result blocks become standalone
  // function_call_output items; text + image_input blocks fold into a single
  // `message` item so each image stays attached to its surrounding text
  // (e.g. the party-portrait prefix — a label line followed by one
  // image_input per PC). Without the image_input branch the portraits were
  // silently dropped and the DM never saw the players' faces. Mirrors the
  // `input_image` translation on the openai-apikey path (`toResponsesInput`
  // in openai.ts).
  const items: unknown[] = [];
  let messageContent: unknown[] = [];
  // Flush accumulated text/image into a `message` item. Called before each
  // `function_call_output` so that if a single user message ever interleaves
  // text/image with tool_result blocks (e.g. imported / hand-edited history),
  // source order is preserved — otherwise all text/image would fold into one
  // trailing message after every function_call_output, reordering the turn.
  const flushMessage = (): void => {
    if (messageContent.length > 0) {
      items.push({ type: "message", role: "user", content: messageContent });
      messageContent = [];
    }
  };
  for (const part of msg.content) {
    if (part.type === "tool_result") {
      flushMessage();
      items.push({
        type: "function_call_output",
        call_id: part.tool_use_id,
        output: part.content,
      });
    } else if (part.type === "text") {
      messageContent.push(userPart(part.text));
    } else if (part.type === "image_input") {
      // Codex's Responses deserializer is stricter than the OpenAI SDK on the
      // image `detail` enum: it accepts only "high" or "original" (NOT the
      // Responses API's "low"/"high"/"auto" — spike-confirmed, it rejects the
      // turn with `unknown variant 'auto'`). Map our abstract lowDetail flag
      // onto that: "high" is codex's cheaper/downscaled floor (right for the
      // low-cost cached portrait prefix), "original" is full resolution.
      messageContent.push({
        type: "input_image",
        detail: part.lowDetail ? "high" : "original",
        image_url: `data:${part.mimeType};base64,${part.base64}`,
      });
    }
  }
  flushMessage();
  return items;
}

// ---------------------------------------------------------------------------
// Per-turn notification accumulator
// ---------------------------------------------------------------------------

// Exported for unit tests — production callers go through OpenAIChatGptProvider.
export class TurnCollector {
  private text = "";
  private reasoning: string[] = [];
  private assistantContent: ContentPart[] = [];
  private latestUsage: TokenUsageUpdatedNotification["tokenUsage"] | null = null;
  /**
   * Count of reasoning items that ARRIVED on `rawResponseItem/completed` this
   * turn. We no longer capture or replay the encrypted blob — codex emits no
   * usable reasoning blob on the ChatGPT-account path, so #533 codex replay was
   * a no-op and was removed (see #607). This counter survives purely to feed the
   * #597 tripwire: "the model demonstrably reasoned (summary deltas streamed)
   * yet no raw reasoning item arrived at all" is what we watch for. See
   * {@link reasoningCaptureStats}.
   */
  private rawReasoningItemsSeen = 0;

  constructor(private readonly onDelta?: (text: string) => void) {}

  onAgentMessageDelta(params: AgentMessageDeltaNotification): void {
    this.text += params.delta;
    this.onDelta?.(params.delta);
  }

  onReasoningDelta(params: AgentMessageDeltaNotification): void {
    this.reasoning.push(params.delta);
  }

  onItemStarted(_params: ItemStartedNotification): void {
    // Currently unused — tool-call items also fire as server requests
    // (handled separately) so we don't need to track them here.
  }

  onRawResponseItem(params: RawResponseItemCompletedNotification): void {
    // Detector-only. We do NOT capture or replay the encrypted reasoning blob:
    // codex surfaces no usable blob on the ChatGPT-account path (it emits no
    // raw reasoning items there at all), so #533 codex replay was a no-op and
    // was removed (#607). We still count reasoning items that arrive so the
    // #597 tripwire can flag "model reasoned but no raw item arrived" — and so
    // that a future account type which DOES emit them (a ZDR/enterprise login,
    // or an upstream codex change) produces a visible signal worth revisiting
    // replay for. See {@link reasoningCaptureStats}.
    if (params.item.type === "reasoning") this.rawReasoningItemsSeen++;
  }

  /**
   * Diagnostic snapshot for the #597 tripwire. `summaryDeltas` proves the model
   * reasoned this turn (it streamed reasoning-summary text on the intact
   * `item/reasoning/*` channel); `rawReasoningItems` is how many reasoning items
   * arrived on the *separate* `rawResponseItem/completed` channel. On a ChatGPT
   * account `rawReasoningItems` is normally 0 (codex emits none there — #607);
   * `summaryDeltas > 0 && rawReasoningItems === 0` is therefore the expected
   * steady state, logged once per session. It would only be a *surprise* if that
   * second channel ever started carrying items — the signal that reasoning
   * preservation became possible and replay (removed with #533's codex path)
   * is worth reconsidering.
   */
  reasoningCaptureStats(): { summaryDeltas: number; rawReasoningItems: number } {
    return {
      summaryDeltas: this.reasoning.length,
      rawReasoningItems: this.rawReasoningItemsSeen,
    };
  }

  onItemCompleted(params: ItemCompletedNotification): void {
    if (params.item.type === "agentMessage" && params.item.text) {
      // Last-text-wins: if we accumulated streaming deltas, the completed
      // item's full text supersedes them only if our accumulation is empty.
      // Otherwise the streaming sum is canonical.
      if (!this.text) this.text = params.item.text;
      if (!this.text) return;
      // The assistantContent for history must include the FINAL committed
      // text. Three cases (Copilot-flagged on #481 — case 3 used to drop
      // the prose entirely):
      //   1. Empty buffer → push the text block.
      //   2. Last block is text → update it in place (streaming case).
      //   3. Last block is a tool_use → append a new text block. Codex
      //      can complete an agentMessage AFTER a tool_use item in the
      //      same turn, and without this branch the assistant prose
      //      vanishes from downstream history.
      const last = this.assistantContent[this.assistantContent.length - 1];
      if (!last) {
        this.assistantContent.push({ type: "text", text: this.text });
      } else if (last.type === "text") {
        last.text = this.text;
      } else {
        this.assistantContent.push({ type: "text", text: this.text });
      }
    }
  }

  onToolCall(call: NormalizedToolCall): void {
    // Codex owns tool dispatch end-to-end (the model gets the tool_result
    // in-band during the same turn), so we deliberately do NOT surface
    // calls back through ChatResult.toolCalls — the bridge would otherwise
    // re-dispatch them after chat() returns, running every write_entity /
    // scribe write twice. assistantContent keeps the tool_use block so the
    // returned conversation history still reflects what the model did.
    this.assistantContent.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }

  onTokenUsage(params: TokenUsageUpdatedNotification): void {
    this.latestUsage = params.tokenUsage;
  }

  toChatResult(completed: TurnCompletedNotification): ChatResult {
    const stopReason: StopReason =
      completed.turn.status === "completed" ? "end"
      : completed.turn.status === "interrupted" ? "end"
      : completed.turn.status === "failed" ? "refusal"
      : "end";

    const usage: NormalizedUsage = this.latestUsage
      ? {
          inputTokens: this.latestUsage.last.inputTokens,
          outputTokens: this.latestUsage.last.outputTokens,
          cacheReadTokens: this.latestUsage.last.cachedInputTokens,
          cacheCreationTokens: 0,
          reasoningTokens: this.latestUsage.last.reasoningOutputTokens,
        }
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };

    // Ensure a trailing text block exists in assistantContent so downstream
    // history reconstruction sees the final assistant message even if
    // item/completed never arrived (shouldn't happen, defensive).
    if (this.text && this.assistantContent.length === 0) {
      this.assistantContent.push({ type: "text", text: this.text });
    }

    // No reasoning items are appended: we capture no encrypted blob on this
    // provider (codex emits none on the ChatGPT-account path — #607), so there
    // is nothing to round-trip. The reasoning *summary* text is still surfaced
    // via `thinkingText` below for the debug dump.
    return {
      text: this.text,
      // Always empty — see onToolCall. Tool calls were dispatched in-band
      // during the turn, so the bridge must not see them here.
      toolCalls: [],
      usage,
      stopReason,
      thinkingText: this.reasoning.length > 0 ? this.reasoning.join("") : undefined,
      assistantContent: this.assistantContent,
    };
  }
}

// Re-export for tests / callers that need to recover from spawn failures.
export { CodexRpcError } from "./rpc.js";

/**
 * Structured classification of a failed codex turn. Decided at the codex
 * boundary so callers route on the `kind` (a stable enum) instead of
 * pattern-matching the human-readable `codexMessage` (which drifts with
 * upstream wording changes). New kinds may be added; consumers using a
 * switch should treat unknown values as `"unknown"`.
 *
 *  - `auth_expired` — the refresh_token was rejected, or codex reported
 *    an OAuth/auth failure. Player needs to re-sign-in.
 *  - `model_not_found` — codex (or its backend) couldn't find the
 *    requested model name. Player needs to pick a different model.
 *  - `tools_schema_mismatch` — codex rejected the tool definitions at
 *    thread start (usually a protocol-version drift between us and codex).
 *  - `unknown` — anything else. Treated as session-fatal by the error
 *    router; better to surface the real codex message and let the player
 *    decide than to claim it's recoverable when it isn't.
 */
export type CodexFailureKind = "auth_expired" | "model_not_found" | "tools_schema_mismatch" | "rate_limited" | "unknown";

/**
 * Classify a raw codex error message into a {@link CodexFailureKind}.
 *
 * Pattern matches are deliberately broad — codex (and the OpenAI backend
 * it speaks to) phrases the same condition multiple ways, so we look for
 * stable substrings rather than exact strings. When in doubt, return
 * `"unknown"` and let the human-readable message speak for itself.
 *
 * Exported for unit tests; production callers see only the
 * `CodexTurnFailedError.kind` field populated from this function.
 */
export function classifyCodexFailure(message: string): CodexFailureKind {
  const m = message.toLowerCase();
  // Rate limit / quota / credits exhausted. On the ChatGPT (codex) provider
  // this is a NORMAL, expected, transient condition — the player has hit their
  // plan's rolling window or run their credit balance to zero — so it must
  // surface as a clean, recoverable message, never a dead-end. Checked first
  // because the phrasings ("usage limit reached", "429", "out of credits") are
  // distinct from the auth/model/tools cases below and we never want a quota
  // failure misread as one of those. NOTE: codex often does NOT fail the turn
  // on quota — it backs off and retries internally — so this classifier is the
  // belt to the suspenders of the caller's turn-stall handling, not the only
  // line of defense.
  if (
    /rate[\s_-]?limit/.test(m)
    || /\b429\b/.test(m)
    || /too\s*many\s*requests/.test(m)
    || /usage\s*limit/.test(m)
    || /\bquota\b/.test(m)
    || /(out\s*of|insufficient|no)\s*credit/.test(m)
    || /credit\s*balance/.test(m)
    || /reached\s+your\s+(usage\s+)?limit/.test(m)
  ) {
    return "rate_limited";
  }
  // Auth: the canonical case from issue #529 is a refresh-token rejection
  // ("Your access token could not be refreshed because your refresh token
  // was already used. Please log out and sign in again."). Also catch the
  // bare 401 / unauthorized / token-expired phrasings codex uses when the
  // access_token is rejected without a recoverable path.
  if (
    /refresh.*token/.test(m)
    || /access[_ ]token.*(expired|invalid|rejected)/.test(m)
    || /unauthorized/.test(m)
    || /\b401\b/.test(m)
    || /log\s*out.*sign\s*in/.test(m)
  ) {
    return "auth_expired";
  }
  // Model not found: codex / OpenAI both phrase this as "model … not found"
  // or "unknown model" or "does not exist". The 404 status sometimes leaks
  // into the message string too.
  if (
    /model.*not\s*found/.test(m)
    || /unknown\s*model/.test(m)
    || /model.*(does\s*not\s*exist|doesn'?t\s*exist)/.test(m)
    || /no\s*such\s*model/.test(m)
  ) {
    return "model_not_found";
  }
  // Tools schema mismatch — codex rejects the dynamic-tool definitions
  // before turn/start completes. Recognisable by "tool" + a validation /
  // schema verb.
  if (
    /tool.*schema/.test(m)
    || /tool.*(invalid|rejected|malformed)/.test(m)
    || /invalid.*tool/.test(m)
  ) {
    return "tools_schema_mismatch";
  }
  return "unknown";
}

/**
 * Thrown when a Codex turn returns `status: "failed"`. Carries the
 * `turn.error.message` Codex reported alongside the failure — without it
 * callers see only `status: "failed"` in the engine log and can't tell why
 * (model not found, auth expired, rate limit, tools schema mismatch, …).
 *
 * The `kind` field is the *stable* classification consumers should branch
 * on. `codexMessage` is the verbatim string codex returned and is intended
 * for user-visible surfacing only — never pattern-match it in code.
 *
 * Why throw instead of returning an empty ChatResult? A failed turn is a
 * system-level error, not a content refusal. The previous behavior mapped
 * `failed → stopReason: "refusal"` with empty text, which callers like
 * setup-conversation (which calls `provider.chat()` directly without an
 * agent-loop wrapper) silently treated as a no-op, rendering nothing to
 * the player. Throwing forces callers to either handle the failure
 * explicitly or surface it as an error event.
 */
export class CodexTurnFailedError extends Error {
  public readonly kind: CodexFailureKind;
  constructor(
    public readonly codexMessage: string,
    public readonly turnId: string,
  ) {
    super(`Codex turn ${turnId} failed: ${codexMessage}`);
    this.name = "CodexTurnFailedError";
    this.kind = classifyCodexFailure(codexMessage);
  }
}

/**
 * Thrown by {@link OpenAIChatGptProvider} when a codex turn goes completely
 * silent past the stall watchdog — no deltas, items, reasoning, tool calls, or
 * `turn/completed`, while NOT inside an MV tool dispatch. The usual cause is
 * codex backing off internally on a persistent rate-limit (429) and never
 * returning; without this the turn would hang indefinitely and freeze the game.
 *
 * Distinct from {@link CodexTurnFailedError}, which means codex itself reported
 * `status: "failed"`: here codex reported *nothing* and MV gave up. Routed to
 * `retryable` by {@link classifyServerError} — the turn is re-sendable once the
 * limit clears, so keep the session alive rather than dropping to menu. The
 * `.message` is user-facing; keep it actionable.
 */
export class CodexTurnStalledError extends Error {
  constructor(
    public readonly idleMs: number,
    public readonly threadId: string,
  ) {
    super(
      `The model stopped responding for ${Math.round(idleMs / 1000)}s — it may be rate-limited or temporarily unavailable. Your turn wasn't lost; try again in a moment.`,
    );
    this.name = "CodexTurnStalledError";
  }
}

/**
 * Thrown by a single image-render attempt when the turn finished cleanly
 * (`turn/completed`, status "completed") but yielded no image bytes by *either*
 * harvest path — nothing inline and nothing on disk. (The common case is the
 * inline base64 dropping on the pipe; the disk fallback normally rescues that,
 * so reaching this means the render genuinely produced nothing.) A distinct
 * class so {@link OpenAIChatGptProvider.generateImage} can retry ONLY this
 * transient case (a fresh render almost always succeeds), while still surfacing
 * auth errors, a failed/interrupted turn, and the render-timeout backstop
 * immediately — none of those self-heal on a cheap retry.
 */
export class ImageGenNoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenNoDataError";
  }
}

/**
 * Thrown when the stored ChatGPT sign-in can no longer be turned into a
 * usable access_token — the refresh_token was rejected (revoked, or rotated
 * out from under us and unrecoverable), or the token store returned no usable
 * tokens. (`pushInitialTokens` returns early when *nothing* is stored, so the
 * "no usable tokens" case here means `refresh()` itself yielded null.)
 *
 * Unlike a {@link CodexTurnFailedError}, this is raised *outside* a codex
 * turn — during `pushInitialTokens` at provider startup, where a plain
 * `Error` would fall through `classifyServerError`'s "retryable" default and
 * surface as a dead retry overlay. It exists as a distinct class so
 * `classifyServerError` can route it to `session-fatal-recoverable` (drop to
 * menu) by *class*, per that module's by-class routing contract. The
 * `.message` is user-facing — keep it actionable. See issue #558.
 */
export class ChatGptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChatGptAuthError";
  }
}
