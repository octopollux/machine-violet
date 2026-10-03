import { randomUUID } from "node:crypto";
import type { KnowledgeOperation } from "@machine-violet/shared/types/knowledge.js";
import { projectCampaignCompendium } from "../entities/public-knowledge.js";
import { getCampaignKnowledge, type KnowledgeFileIO } from "../knowledge/store.js";
import { logEvent } from "../context/engine-log.js";
import type { ContentPart, LLMProvider, NormalizedMessage, TierProvider } from "../providers/types.js";
import { getModel, type ModelTier } from "../config/models.js";
import type { GameState } from "./game-state.js";
import type { ConversationManager, DroppedExchange } from "../context/index.js";
import { renderCampaignLog } from "../context/index.js";
import type { CampaignLog, CampaignLogEntry } from "../context/index.js";
import { buildDMPrefix, buildActiveState, buildHardStats } from "./dm-prompt.js";
import type { DMSessionState } from "./dm-prompt.js";
import type { CachedPrefixResult } from "../context/index.js";
import { summarizeScene } from "./subagents/scene-summarizer.js";
import { generateNarrativeRecap } from "./subagents/narrative-recap.js";
import { updatePrecis } from "./subagents/precis-updater.js";
import { trackScene } from "./subagents/scene-tracker.js";
import type { PlayerRead } from "./subagents/precis-updater.js";
import { updateChangelogs, parseChangelogEntries, planChangelogEntries } from "./subagents/changelog-updater.js";
import { updateCompendium, renderCompendiumForDM, planPublicCompendium } from "./subagents/compendium-updater.js";
import { IMAGE_CADENCE_PER_100_DEFAULT, clampImageCadencePer100 } from "@machine-violet/shared/types/config.js";
import { advanceCalendar, checkClocks } from "../tools/clocks/index.js";
import { validateCampaign } from "../tools/validation/index.js";
import type { ValidationResult } from "../tools/validation/index.js";
import { join } from "node:path";
import { sceneDir, campaignPaths, machinePaths, parseFrontMatter, extractSection, renderEntityTree } from "../tools/filesystem/index.js";
import type { EntityTree, EntityTreeEntry } from "@machine-violet/shared/types/entities.js";
import { slugify } from "./world-builder.js";
import { findSystem, effectiveMechanicsMode } from "../config/systems.js";
import type { UsageStats } from "./agent-loop.js";
import { accUsage } from "../context/usage-helpers.js";
import { norm } from "../utils/paths.js";
import type { CampaignRepo } from "../tools/git/index.js";

// --- Types ---

export interface SceneState {
  /** Persisted complete tree snapshot: immutable until the next scene. */
  knowledgeSnapshot?: string;
  knowledgeSnapshotScene?: number;
  sceneNumber: number;
  slug: string;
  transcript: string[];
  precis: string;
  /** Unresolved narrative threads for the current scene, maintained by the precis updater. */
  openThreads: string;
  /** Active NPC intentions/plans, maintained by the precis updater. */
  npcIntents: string;
  playerReads: PlayerRead[];
  sessionNumber: number;
  /** True when the previous session ended cleanly and its recap has not yet been shown to the player. */
  sessionRecapPending: boolean;
}

export type PendingStep =
  | "finalize_transcript"
  | "subagent_updates"
  | "advance_calendar"
  | "check_alarms"
  | "validate"
  | "reset_precis"
  | "prune_context"
  | "checkpoint"
  | "done";

export interface PendingOperation {
  type: "scene_transition" | "session_end";
  step: PendingStep;
  sceneNumber: number;
  title: string;
  timeAdvance?: number;
  /** Unique cascade instance; scene numbers may recur in earlier format-2 recovery. */
  transitionId?: string;
  /** Exact post-advance clocks, saved before writing clocks.json. */
  calendar?: { clocks: GameState["clocks"]; alarmsFired: string[] };
  /** Generated proposals persisted before any campaign updates are applied. */
  updates?: {
    entry: CampaignLogEntry;
    operations: KnowledgeOperation[];
    publicOperations?: KnowledgeOperation[];
    publicationError?: string;
    changelogEntries: string[];
  };
}

export interface TransitionResult {
  campaignLogEntry: string;
  changelogEntries: string[];
  alarmsFired: string[];
  validationIssues?: ValidationResult;
  usage: UsageStats;
}

/**
 * File I/O interface — abstracts filesystem for testability.
 * In production, these map to fs.readFile/writeFile/mkdir.
 */
export interface FileIO extends KnowledgeFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Replace a synced complete file without truncating its prior contents. */
  writeFileAtomic?(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  deleteFile?(path: string): Promise<void>;
  /** Remove an empty directory. Rejects if the directory is not empty. */
  rmdir?(path: string): Promise<void>;
  /**
   * Write raw bytes (e.g. a generated PNG). Optional so existing test
   * mocks that only need text I/O don't have to change; production
   * implementations always provide this. The image-handler errors
   * loudly if it's absent at runtime — better than silently dropping
   * the image bytes.
   */
  writeBinaryFile?(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Read raw bytes (e.g. a character portrait PNG to embed in the DM's
   * cached prefix as an image_input ContentPart). Optional for the same
   * reason as writeBinaryFile; production fileIO always provides it.
   * Callers that need bytes for an optional feature (portraits in DM
   * context) should skip gracefully when absent rather than throwing.
   */
  readBinaryFile?(path: string): Promise<Uint8Array>;
}

/** Ordered cascade steps for scene transitions. Used for resume logic. */
const STEP_ORDER: PendingStep[] = [
  "finalize_transcript", "subagent_updates",
  "advance_calendar", "check_alarms", "validate",
  "reset_precis", "prune_context", "checkpoint", "done",
];

/** Join the text blocks of a message's content (string content passes through). */
function narrationText(content: NormalizedMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b: ContentPart): b is Extract<ContentPart, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// --- Scene Manager ---

export class SceneManager {
  private state: GameState;
  private scene: SceneState;
  private conversation: ConversationManager;
  private sessionState: DMSessionState;
  private fileIO: FileIO;
  private repo: CampaignRepo | null;
  private pendingOp: PendingOperation | null = null;
  private pcSummaries: string[];
  private aliasContext = "";
  private entityTree: EntityTree;
  /**
   * Rendered entity-registry snapshot fed to the DM (via `entityIndex`).
   * Recomputed lazily: a tree mutation marks it dirty and the next read
   * re-renders once — so a scribe turn applying many deltas doesn't re-sort
   * and re-render the whole registry per delta.
   */
  private entityTreeSnapshot: string | undefined;
  /** Content boundaries snapshot — refreshed at scene transitions only. */
  private contentBoundariesSnapshot: string | undefined;
  /**
   * Per-tier {provider, model} resolution for subagent dispatch. When supplied,
   * methods route subagent calls through `this.tierProviders[tier]` so a
   * heterogeneous setup (Large=OpenAI, Medium/Small=Anthropic) sends each call
   * to the matching vendor. When omitted (legacy test paths), the `provider`
   * argument passed into each method is reused for the tier and `getModel(tier)`
   * provides the default model — preserving pre-PR-440 behavior.
   */
  private tierProviders: Record<ModelTier, TierProvider> | undefined;

  /** Optional dev mode log callback. */
  devLog?: (msg: string) => void;

  constructor(
    state: GameState,
    scene: SceneState,
    conversation: ConversationManager,
    sessionState: DMSessionState,
    fileIO: FileIO,
    repo?: CampaignRepo,
    entityTree?: EntityTree,
    tierProviders?: Record<ModelTier, TierProvider>,
    private readonly afterSceneAdvanced?: () => Promise<void>,
  ) {
    this.state = state;
    this.scene = scene;
    this.conversation = conversation;
    this.sessionState = sessionState;
    this.fileIO = fileIO;
    this.repo = repo ?? null;
    this.entityTree = entityTree ?? {};
    this.entityTreeSnapshot = renderEntityTree(this.entityTree);
    this.contentBoundariesSnapshot = sessionState.contentBoundaries;
    this.pcSummaries = state.config.players.map((p) => p.character);
    this.tierProviders = tierProviders;
  }

  /**
   * Resolve a tier's `{provider, model}` for a subagent call. When a
   * per-tier map exists, return that tier's pair; otherwise pair the
   * caller's `provider` arg with the tier's default model.
   */
  private routeFor(tier: ModelTier, fallbackProvider: LLMProvider): TierProvider {
    return this.tierProviders?.[tier] ?? { provider: fallbackProvider, model: getModel(tier) };
  }

  /**
   * Build the volatile `[stats]` string for the current state. Shared by
   * getSystemPrompt and contextRefresh so the system/silent line and resources
   * stay consistent — contextRefresh runs after scene transitions, and must not
   * drop the active-system reminder from the hard-stats cadence.
   */
  private buildCurrentHardStats(turnHolder?: string, turnsSinceImage?: number): string {
    const system = this.state.config.system;
    const imagesOn = this.state.config.image_generation === "on";
    return buildHardStats({
      turnHolder,
      resourceValues: this.state.resourceValues,
      activeSystem: system ? (findSystem(system)?.name ?? system) : undefined,
      mechanicsSilent: effectiveMechanicsMode(this.state.config) === "dm-managed",
      ...(imagesOn && turnsSinceImage != null
        ? {
            turnsSinceImage,
            imageCadencePer100: clampImageCadencePer100(
              this.state.config.image_cadence_per_100 ?? IMAGE_CADENCE_PER_100_DEFAULT,
            ),
          }
        : {}),
    });
  }

  /** Get the current system prompt (cached prefix) and volatile context. */
  getSystemPrompt(opts?: { turnHolder?: string; turnsSinceImage?: number }): CachedPrefixResult {
    this.state.objectives.current_scene = this.scene.sceneNumber;
    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.pcSummaries,
      pendingAlarms: [],
      activeObjectives: this.getActiveObjectives(),
    });
    this.sessionState.hardStats = this.buildCurrentHardStats(opts?.turnHolder, opts?.turnsSinceImage);
    this.sessionState.scenePrecis = buildScenePrecis(this.scene);
    this.sessionState.playerRead = synthesizePlayerRead(this.scene.playerReads);
    this.sessionState.entityIndex = this.scene.knowledgeSnapshot ?? this.entityTreeSnapshot;
    this.sessionState.contentBoundaries = this.contentBoundariesSnapshot;
    // Use the runtime tier-resolved model for prompt conditionals
    // (`<!--if:gpt-->` etc.) so the DM prompt branches match the provider
    // actually serving the request. Falls back to the static large default
    // when tierProviders isn't supplied (legacy test paths).
    const dmModelId = this.tierProviders?.large.model ?? getModel("large");
    return buildDMPrefix(this.state.config, this.sessionState, dmModelId);
  }

  /** Append to the scene transcript */
  appendTranscript(entry: string): void {
    this.scene.transcript.push(entry);
  }

  /** Format and append a player input to transcript */
  appendPlayerInput(characterName: string, text: string): void {
    this.appendTranscript(`**[${characterName}]** ${text}`);
  }

  /** Format and append a DM response to transcript */
  appendDMResponse(text: string): void {
    this.appendTranscript(`**DM:** ${text}`);
  }

  /** Format and append a tool result to transcript */
  appendToolResult(toolName: string, result: string): void {
    this.appendTranscript(`> \`${toolName}\`: ${result}`);
  }

  /** Handle a dropped exchange — trigger precis update */
  async handleDroppedExchange(
    provider: LLMProvider,
    dropped: DroppedExchange,
  ): Promise<UsageStats> {
    // Format the dropped exchange as text. The stored assistant message is the
    // canonical turn's final message, whose content is an array of blocks, so
    // pull the narration out of its text block(s).
    const userContent = typeof dropped.exchange.user.content === "string"
      ? dropped.exchange.user.content
      : narrationText(dropped.exchange.user.content);
    const assistantContent = narrationText(dropped.exchange.assistant.content);
    const exchangeText = `Player: ${userContent}\nDM: ${assistantContent}`;

    const pcIdent = this.state.config.players
      .map((p) => `[[${p.character}]] (${p.name})`)
      .join(", ");

    this.devLog?.("[dev] subagent:precis-updater starting");
    const r = this.routeFor("small", provider);
    const result = await updatePrecis(
      r.provider, this.scene.precis, exchangeText,
      this.scene.openThreads || undefined,
      pcIdent,
      this.aliasContext || undefined,
      this.scene.npcIntents || undefined,
      r.model,
    );
    this.devLog?.("[dev] subagent:precis-updater done");
    this.scene.precis += "\n" + result.text;
    if (result.openThreads !== undefined) {
      this.scene.openThreads = result.openThreads;
    }
    if (result.npcIntents !== undefined) {
      this.scene.npcIntents = result.npcIntents;
    }
    if (result.playerRead) {
      this.scene.playerReads.push(result.playerRead);
    }
    return result.usage;
  }

  /** Run the scene tracker to update open threads and NPC intents. */
  async runSceneTracker(provider: LLMProvider): Promise<UsageStats> {
    const tail = this.scene.transcript;
    if (tail.length === 0) {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    }

    this.devLog?.("[dev] subagent:scene-tracker starting");
    const r = this.routeFor("small", provider);
    const result = await trackScene(
      r.provider,
      tail,
      this.scene.openThreads || undefined,
      this.scene.npcIntents || undefined,
      r.model,
    );
    this.devLog?.("[dev] subagent:scene-tracker done");

    if (result.openThreads !== undefined) {
      this.scene.openThreads = result.openThreads;
    }
    if (result.npcIntents !== undefined) {
      this.scene.npcIntents = result.npcIntents;
    }
    return result.usage;
  }

  /**
   * Execute the scene_transition cascade.
   * Each step is tracked in pendingOp for idempotent recovery.
   */
  async sceneTransition(
    provider: LLMProvider,
    title: string,
    timeAdvance?: number,
  ): Promise<TransitionResult> {
    const interrupted = this.pendingOp;
    if (interrupted) {
      this.devLog?.(`[dev] recovering interrupted scene transition "${interrupted.title}" before accepting another transition`);
      const recovered = await this.resumePendingTransition(provider, interrupted);
      return recovered ?? {
        campaignLogEntry: interrupted.updates?.entry.full ?? "",
        changelogEntries: interrupted.updates?.changelogEntries ?? [],
        alarmsFired: interrupted.calendar?.alarmsFired ?? [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    }
    const totalUsage: UsageStats = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    const result: TransitionResult = {
      campaignLogEntry: "",
      changelogEntries: [],
      alarmsFired: [],
      usage: totalUsage,
    };

    this.pendingOp = {
      type: "scene_transition",
      transitionId: randomUUID(),
      step: "finalize_transcript",
      sceneNumber: this.scene.sceneNumber,
      title,
      timeAdvance,
    };
    await this.savePendingOp();

    // Step 1: Finalize transcript to disk
    this.pendingOp.step = "finalize_transcript";
    await this.stepFinalizeTranscript();

    // Step 2: Parallel subagent updates (campaign log + entity changelogs)
    this.pendingOp.step = "subagent_updates";
    await this.savePendingOp();
    await this.stepSubagentUpdates(provider, title, result);

    // Step 4: Advance calendar
    this.pendingOp.step = "advance_calendar";
    await this.savePendingOp();
    await this.stepAdvanceCalendar(timeAdvance, result);

    // Step 5: Check alarms
    this.pendingOp.step = "check_alarms";
    await this.savePendingOp();
    this.stepCheckAlarms();

    // Step 5b: Validation
    this.pendingOp.step = "validate";
    await this.savePendingOp();
    result.validationIssues = await this.stepValidate();

    // Step 6: Reset precis and player reads
    this.pendingOp.step = "reset_precis";
    await this.stepResetPrecis();

    // Step 7: Prune context
    this.pendingOp.step = "prune_context";
    this.stepPruneContext();

    // Step 8: Checkpoint (git commit would go here)
    this.pendingOp.step = "checkpoint";
    await this.savePendingOp();
    await this.stepCheckpoint();

    // All cascade effects completed. The durable done marker bridges a crash
    // before the next identity/tree are saved; it is cleared only afterward.
    this.pendingOp.step = "done";
    await this.savePendingOp();
    await this.finishSceneAdvance(result);
    return result;
  }

  /** End the session: final scene transition + session recap */
  async sessionEnd(
    provider: LLMProvider,
    title: string,
    timeAdvance?: number,
  ): Promise<TransitionResult> {
    const result = await this.sceneTransition(provider, title, timeAdvance);

    // Write session recap
    const paths = campaignPaths(this.state.campaignRoot);
    const recapPath = paths.sessionRecap(this.scene.sessionNumber);
    await this.fileIO.writeFile(recapPath, `# Session ${this.scene.sessionNumber} Recap\n\n${result.campaignLogEntry}\n`);

    // Generate narrative recap for the "Previously on..." modal
    try {
      const r = this.routeFor("small", provider);
      const narrativeResult = await generateNarrativeRecap(
        r.provider,
        result.campaignLogEntry,
        this.state.config.name,
        r.model,
      );
      await this.fileIO.writeFile(
        paths.sessionRecapNarrative(this.scene.sessionNumber),
        narrativeResult.text,
      );
      accUsage(result.usage, narrativeResult.usage);
    } catch {
      // Non-critical — bullet recap still exists for fallback
    }

    // Mark recap as pending — session-manager will deliver it in the first
    // state:snapshot after the next session resume, then clear the flag.
    this.scene.sessionRecapPending = true;

    // Git session commit
    await this.repo?.sessionCommit(this.scene.sessionNumber);

    return result;
  }

  /**
   * Resume an interrupted scene-transition cascade.
   * Picks up from the step recorded in pendingOp and runs through to checkpoint.
   * Returns null if the pending op is already done or has an unknown step.
   */
  async resumePendingTransition(
    provider: LLMProvider,
    pendingOp: PendingOperation,
  ): Promise<TransitionResult | null> {
    // Normalize legacy step names from before subagent parallelization
    let effectiveStep = pendingOp.step as string;
    if (effectiveStep === "campaign_log" || effectiveStep === "changelog_updates") {
      effectiveStep = "subagent_updates";
    }

    const startIdx = STEP_ORDER.indexOf(effectiveStep as PendingStep);
    if (startIdx === -1) {
      await this.clearPendingOp();
      return null;
    }
    this.pendingOp = { ...pendingOp, transitionId: pendingOp.transitionId ?? randomUUID() };
    // Older format-2 pending cascades receive an instance before generating or
    // applying updates. Retries retain it even when this first recovery fails.
    await this.savePendingOp();
    if (effectiveStep === "done" || this.scene.sceneNumber === pendingOp.sceneNumber + 1) {
      await this.finishSceneAdvance({ campaignLogEntry: "", changelogEntries: [], alarmsFired: pendingOp.calendar?.alarmsFired ?? [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } });
      return null;
    }
    if (this.scene.sceneNumber !== pendingOp.sceneNumber)
      throw new Error("Pending scene transition does not match the current scene identity");

    const totalUsage: UsageStats = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    const result: TransitionResult = {
      campaignLogEntry: "",
      changelogEntries: [],
      alarmsFired: [...(pendingOp.calendar?.alarmsFired ?? [])],
      usage: totalUsage,
    };

    // Run from startIdx through checkpoint (skip "done")
    const endIdx = STEP_ORDER.indexOf("done");
    for (let i = startIdx; i < endIdx; i++) {
      const step = STEP_ORDER[i];
      this.pendingOp.step = step;
      await this.savePendingOp();

      switch (step) {
        case "finalize_transcript": await this.stepFinalizeTranscript(); break;
        case "subagent_updates": await this.stepSubagentUpdates(provider, pendingOp.title, result); break;
        case "advance_calendar": await this.stepAdvanceCalendar(pendingOp.timeAdvance, result); break;
        case "check_alarms": this.stepCheckAlarms(); break;
        case "validate": result.validationIssues = await this.stepValidate(); break;
        case "reset_precis": await this.stepResetPrecis(); break;
        case "prune_context": this.stepPruneContext(); break;
        case "checkpoint": await this.stepCheckpoint(); break;
      }
    }

    this.pendingOp.step = "done";
    await this.savePendingOp();
    await this.finishSceneAdvance(result);
    return result;
  }

  /**
   * Resume a session: load campaign state, build prefix, return recap.
   * Returns the session recap text for display in a modal.
   */
  async sessionResume(): Promise<string> {
    const paths = campaignPaths(this.state.campaignRoot);

    // Try to load session recap (bullet version — always used for DM prefix)
    const recapPath = paths.sessionRecap(this.scene.sessionNumber - 1);
    let recap = "";
    if (await this.fileIO.exists(recapPath)) {
      recap = await this.fileIO.readFile(recapPath);
    }

    // Load narrative recap for player display (falls back to bullet recap)
    let narrativeRecap = "";
    const narrativePath = paths.sessionRecapNarrative(this.scene.sessionNumber - 1);
    if (await this.fileIO.exists(narrativePath)) {
      narrativeRecap = await this.fileIO.readFile(narrativePath);
    }

    // Load the supported campaign log JSON
    this.sessionState.campaignSummary = await this.loadAndRenderCampaignLog();

    this.sessionState.compendiumSummary = renderCompendiumForDM(await projectCampaignCompendium(await getCampaignKnowledge(this.state.campaignRoot, this.fileIO)));

    if (recap) {
      this.sessionState.sessionRecap = recap;
    }

    // Run validation after loading state
    try {
      const validation = await validateCampaign(
        this.state.campaignRoot,
        this.state.maps,
        this.state.clocks,
        this.fileIO,
      );
      this.devLog?.(`[dev] session resume validation: ${validation.errorCount} errors, ${validation.warningCount} warnings, ${validation.filesChecked} files`);
    } catch (e) {
      this.devLog?.(`[dev] session resume validation failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Only return a recap for player display when the flag is set — i.e. the
    // previous session ended cleanly and this is the first resume afterward.
    // Mid-session reconnects (no clean sessionEnd) leave the flag false.
    if (!this.scene.sessionRecapPending) {
      return "";
    }
    this.scene.sessionRecapPending = false;
    return narrativeRecap || recap;
  }

  private async finishSceneAdvance(result: TransitionResult): Promise<void> {
    const operation = this.pendingOp;
    if (!operation) throw new Error("Missing pending scene transition");
    if (this.scene.sceneNumber === operation.sceneNumber) {
      this.scene.sceneNumber = operation.sceneNumber + 1;
      this.scene.slug = "";
      this.scene.transcript = [];
      let summary = result.campaignLogEntry || operation.updates?.entry.full || "";
      if (!summary) {
        try {
          const log = JSON.parse(await this.fileIO.readFile(campaignPaths(this.state.campaignRoot).log)) as CampaignLog;
          const matching = operation.transitionId
            ? log.entries.find(entry => entry.transitionId === operation.transitionId)
            : undefined;
          summary = matching?.full ?? log.entries.filter(entry => entry.sceneNumber === operation.sceneNumber).at(-1)?.full ?? "";
        } catch { /* the campaign log remains available through contextRefresh */ }
      }
      this.scene.precis = buildSceneAnchor(operation.title, summary, result.alarmsFired);
    } else if (this.scene.sceneNumber !== operation.sceneNumber + 1) {
      throw new Error("Pending scene transition does not match the current scene identity");
    }
    // These files may have failed independently of the saved successor. A
    // pending completion cannot carry old exchanges/reads into the next scene.
    this.scene.openThreads = "";
    this.scene.npcIntents = "";
    this.scene.playerReads = [];
    this.conversation.clear();
    await this.prepareKnowledgeContext();
    await this.afterSceneAdvanced?.();
    await this.clearPendingOp();
  }

  /** Context refresh: re-read campaign log, session recap, rebuild active state */
  async contextRefresh(): Promise<void> {
    await this.prepareKnowledgeContext();
    const root = this.state.campaignRoot;
    const paths = campaignPaths(root);

    // Re-read campaign log (JSON, rendered with budget)
    try {
      this.sessionState.campaignSummary = await this.loadAndRenderCampaignLog();
    } catch { /* non-critical */ }

    // Re-read previous session recap
    try {
      const recapPath = paths.sessionRecap(this.scene.sessionNumber - 1);
      if (await this.fileIO.exists(recapPath)) {
        this.sessionState.sessionRecap = await this.fileIO.readFile(recapPath);
      }
    } catch { /* non-critical */ }

    this.sessionState.compendiumSummary = renderCompendiumForDM(await projectCampaignCompendium(await getCampaignKnowledge(this.state.campaignRoot, this.fileIO)));

    // Refresh PC summaries with alias info and build alias context for subagents
    this.pcSummaries = await this.loadPCSummaries();
    this.aliasContext = await this.buildAliasContext();

    // Rebuild active state with pending alarms
    const clockStatus = checkClocks(this.state.clocks);
    const pendingAlarms: string[] = [];
    if (clockStatus.calendar.next_alarm) {
      pendingAlarms.push(clockStatus.calendar.next_alarm.message);
    }
    if (clockStatus.combat.next_alarm) {
      pendingAlarms.push(clockStatus.combat.next_alarm.message);
    }

    this.state.objectives.current_scene = this.scene.sceneNumber;
    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.pcSummaries,
      pendingAlarms,
      activeObjectives: this.getActiveObjectives(),
    });
    this.sessionState.hardStats = this.buildCurrentHardStats();

    // Sync precis and player read
    this.sessionState.scenePrecis = buildScenePrecis(this.scene);
    this.sessionState.playerRead = synthesizePlayerRead(this.scene.playerReads);
  }

  /** Get current pending operation (for recovery) */
  getPendingOp(): PendingOperation | null {
    return this.pendingOp;
  }

  /** Get scene state */
  getScene(): SceneState {
    return this.scene;
  }

  /** Get session state (for re-linking after conversation hydration) */
  getSessionState(): DMSessionState {
    return this.sessionState;
  }

  /** Get file IO (for re-linking after conversation hydration) */
  getFileIO(): FileIO {
    return this.fileIO;
  }

  /** Get campaign repo (for shutdown use) */
  getRepo(): CampaignRepo | null {
    return this.repo;
  }

  /** Upsert an entry in the entity tree. */
  upsertEntity(entry: EntityTreeEntry & { slug: string }): void {
    this.entityTree[entry.slug] = {
      name: entry.name,
      aliases: entry.aliases,
      type: entry.type,
      path: entry.path,
    };
  }

  /** Remove an entry from the entity tree (e.g. after rename). */
  removeEntity(slug: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.entityTree[slug];
  }

  /** Capture once per scene; live scribe organization comes directly from the store. */
  async prepareKnowledgeContext(): Promise<void> {
    if (this.scene.knowledgeSnapshotScene === this.scene.sceneNumber && this.scene.knowledgeSnapshot !== undefined) return;
    const store = await getCampaignKnowledge(this.state.campaignRoot, this.fileIO);
    this.scene.knowledgeSnapshot = await store.snapshot();
    this.scene.knowledgeSnapshotScene = this.scene.sceneNumber;
    this.sessionState.entityIndex = this.scene.knowledgeSnapshot;
    logEvent("knowledge:snapshot", { scene: this.scene.sceneNumber, bytes: Buffer.byteLength(this.scene.knowledgeSnapshot), estimatedTokens: Math.ceil(this.scene.knowledgeSnapshot.length / 4), nodes: (await store.outline()).length });
  }

  /** Get the current entity tree (for passing to subagents). */
  getEntityTree(): EntityTree {
    return this.entityTree;
  }

  // --- Campaign log loading ---

  /**
   * Load supported campaign log JSON,
   * and render with token budget for system prompt inclusion.
   */
  private async loadAndRenderCampaignLog(): Promise<string> {
    const paths = campaignPaths(this.state.campaignRoot);
    const budget = this.state.config.context?.campaign_log_budget ?? 15000;

    // Try log.json first
    if (await this.fileIO.exists(paths.log)) {
      try {
        const raw = await this.fileIO.readFile(paths.log);
        const log = JSON.parse(raw) as CampaignLog;
        return renderCampaignLog(log, budget);
      } catch { /* missing/corrupt narrative log is non-critical */ }
    }

    return "";
  }

  // --- Transition step methods ---

  /**
   * Write the current transcript to disk without triggering a scene
   * transition cascade.  Safe to call repeatedly (skips when empty).
   * Used by graceful shutdown to persist transcript before exit.
   */
  async flushTranscript(): Promise<void> {
    if (this.scene.transcript.length === 0) return;
    await this.finalizeTranscript();
  }

  private async stepFinalizeTranscript(): Promise<void> {
    await this.finalizeTranscript();
  }

  private async stepSubagentUpdates(
    provider: LLMProvider,
    title: string,
    result: TransitionResult,
  ): Promise<void> {
    const pending = this.pendingOp;
    if (!pending?.transitionId) throw new Error("Missing scene transition instance");
    const store = await getCampaignKnowledge(this.state.campaignRoot, this.fileIO);
    if (!pending.updates) {
      const transcript = this.scene.transcript.join("\n");
      const playerTranscript = transcript.split("\n").filter(line => !line.startsWith("> `")).join("\n");
      const route = this.routeFor("small", provider);
      this.devLog?.("[dev] subagent:summarizer starting");
      const summaryPromise = summarizeScene(route.provider, playerTranscript, this.aliasContext || undefined, route.model);
      const changelogPromise = (async () => {
        const identities = await this.listEntityFiles();
        if (!identities.length) return [];
        this.devLog?.(`[dev] subagent:changelog starting (${identities.length} entities)`);
        const generated = await updateChangelogs(route.provider, transcript, pending.sceneNumber, identities, this.aliasContext || undefined, route.model);
        accUsage(result.usage, generated.usage);
        this.devLog?.("[dev] subagent:changelog done");
        return parseChangelogEntries(generated.text);
      })();
      const compendiumPromise = summaryPromise.then(async summary => {
        const current = await projectCampaignCompendium(store);
        this.devLog?.("[dev] subagent:compendium starting");
        const generated = await updateCompendium(route.provider, current, summary.full, pending.sceneNumber, this.aliasContext || undefined, route.model);
        accUsage(result.usage, generated.usage);
        this.devLog?.("[dev] subagent:compendium done");
        return generated.compendium;
      }).catch((error: unknown) => {
        // Player compendium generation remains optional. It never writes here.
        this.devLog?.(`[dev] compendium update failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      // Even a failed generator must wait for siblings. No model call or writer
      // can outlive this step and race recovery or shutdown.
      const [summary, changelog, compendium] = await Promise.allSettled([summaryPromise, changelogPromise, compendiumPromise]);
      if (summary.status === "rejected") throw summary.reason;
      if (changelog.status === "rejected") throw changelog.reason;
      if (compendium.status === "rejected") throw compendium.reason;
      accUsage(result.usage, summary.value.usage);
      this.devLog?.("[dev] subagent:summarizer done");
      const operations = await planChangelogEntries(store, changelog.value, pending.sceneNumber);
      let publicOperations: KnowledgeOperation[] = [];
      let publicationError: string | undefined;
      if (compendium.value) {
        try { publicOperations = await planPublicCompendium(store, compendium.value, pending.sceneNumber); }
        catch (error) { publicationError = error instanceof Error ? error.message : String(error); }
      }
      pending.updates = {
        entry: { sceneNumber: pending.sceneNumber, title, full: summary.value.full, mini: summary.value.mini, transitionId: pending.transitionId },
        changelogEntries: changelog.value,
        operations, publicOperations, publicationError,
      };
      // The journal is durable before the first mutation. A retry replays this
      // exact payload instead of regenerating wording or replanning identities.
      await this.savePendingOp();
    }
    // Also retry a previously failed journal write before applying its payload.
    await this.savePendingOp();
    const journal = pending.updates;
    result.campaignLogEntry = journal.entry.full;
    result.changelogEntries = journal.changelogEntries;
    await store.mutate(journal.operations, {
      sceneNumber: pending.sceneNumber, source: "scene-updates",
      operationId: `scene-updates:${pending.transitionId}`,
    });
    if (!journal.publicationError && journal.publicOperations?.length) {
      try {
        await store.mutate(journal.publicOperations, {
          sceneNumber: pending.sceneNumber, source: "scene-publication",
          operationId: `scene-publication:${pending.transitionId}`,
        });
      } catch (error) {
        // Optional publication is a separate atomic receipt-backed batch. A
        // malformed proposal cannot poison required histories or trap recovery.
        journal.publicationError = error instanceof Error ? error.message : String(error);
        await this.savePendingOp();
      }
    }
    if (journal.publicationError) this.devLog?.(`[dev] compendium update failed (non-critical): ${journal.publicationError}`);
    await this.stepCampaignLog(journal.entry);
    this.sessionState.compendiumSummary = renderCompendiumForDM(await projectCampaignCompendium(store));
  }

  private async stepCampaignLog(entry: CampaignLogEntry): Promise<void> {
    const paths = campaignPaths(this.state.campaignRoot);
    let log: CampaignLog;
    if (await this.fileIO.exists(paths.log)) {
      // Do not discard an unreadable existing narrative log during recovery.
      log = JSON.parse(await this.fileIO.readFile(paths.log)) as CampaignLog;
    } else {
      log = { campaignName: this.state.config.name, entries: [] };
    }
    const index = log.entries.findIndex(existing => existing.transitionId === entry.transitionId);
    if (index >= 0) log.entries[index] = entry;
    else log.entries.push(entry);
    await this.writeCriticalFile(paths.log, JSON.stringify(log, null, 2));
    await this.fileIO.writeFile(paths.sceneSummary(entry.sceneNumber, this.scene.slug || "untitled"), entry.full);
  }

  private async stepAdvanceCalendar(
    timeAdvance: number | undefined,
    result: TransitionResult,
  ): Promise<void> {
    if (!timeAdvance || timeAdvance <= 0) return;
    const pending = this.pendingOp;
    if (!pending) throw new Error("Missing pending calendar advance");
    if (!pending.calendar) {
      const clocks = structuredClone(this.state.clocks);
      const fired = advanceCalendar(clocks, timeAdvance);
      pending.calendar = { clocks, alarmsFired: fired.map(alarm => alarm.message) };
    }
    // A failed write or crash replays the exact proposed state, never advances
    // an already-written calendar a second time.
    await this.savePendingOp();
    await this.writeCriticalFile(join(this.state.campaignRoot, "state", "clocks.json"), JSON.stringify(pending.calendar.clocks, null, 2));
    Object.assign(this.state.clocks, structuredClone(pending.calendar.clocks));
    result.alarmsFired = [...pending.calendar.alarmsFired];
  }

  private stepCheckAlarms(): void {
    checkClocks(this.state.clocks);
  }

  private async stepValidate(): Promise<ValidationResult | undefined> {
    try {
      const result = await validateCampaign(
        this.state.campaignRoot,
        this.state.maps,
        this.state.clocks,
        this.fileIO,
      );
      if (result.errorCount > 0 || result.warningCount > 0) {
        this.devLog?.(`[dev] validation: ${result.errorCount} errors, ${result.warningCount} warnings`);
      }
      return result;
    } catch (e) {
      this.devLog?.(`[dev] validation failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private async stepResetPrecis(): Promise<void> {
    this.scene.precis = "";
    this.scene.openThreads = "";
    this.scene.npcIntents = "";
    this.scene.playerReads = [];
    // Entity registry may have changed during the scene; refresh on next read.
    // Refresh content boundaries snapshot (picks up any Scribe updates)
    await this.refreshContentBoundaries();
  }

  /** Re-read machine-scope player files and rebuild content boundaries snapshot. */
  async refreshContentBoundaries(): Promise<void> {
    this.contentBoundariesSnapshot = await loadContentBoundaries(
      this.state.config.players,
      this.state.homeDir,
      this.fileIO,
    );
  }

  private stepPruneContext(): void {
    this.conversation.clear();
  }

  private async stepCheckpoint(): Promise<void> {
    await this.repo?.sceneCommit(this.pendingOp?.title ?? "untitled");
  }

  // --- Internal ---

  private async loadPCSummaries(): Promise<string[]> {
    const store = await getCampaignKnowledge(this.state.campaignRoot, this.fileIO);
    const summaries: string[] = [];
    for (const player of this.state.config.players) {
      const uid = await store.resolve(player.character);
      if (!uid) { summaries.push(player.character); continue; }
      const node = await store.read(uid, { textLimit: 0, logLimit: 0 });
      const aliases = node.aliases.filter((alias) => alias.toLocaleLowerCase() !== node.name.toLocaleLowerCase());
      summaries.push(`${node.uid}: ${node.name}${aliases.length ? ` (also: ${aliases.join(", ")})` : ""}${typeof node.fields.theme_color === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(node.fields.theme_color) ? ` [theme color: ${node.fields.theme_color}]` : ""}`);
    }
    return summaries;
  }

  private async buildAliasContext(): Promise<string> {
    const store = await getCampaignKnowledge(this.state.campaignRoot, this.fileIO);
    const lines: string[] = [];
    for (const node of await store.outline()) {
      if (node.kind !== "entity") continue;
      const record = await store.read(node.uid, { textLimit: 0, logLimit: 0 });
      lines.push(`${node.uid}: ${record.name}${record.aliases.length ? ` (also ${record.aliases.join(", ")})` : ""}`);
    }
    return lines.length ? `\n\nCanonical campaign identities (use UIDs):\n${lines.join("\n")}` : "";
  }

  private async finalizeTranscript(): Promise<void> {
    const dir = sceneDir(
      this.state.campaignRoot,
      this.scene.sceneNumber,
      this.scene.slug || "untitled",
    );
    await this.fileIO.mkdir(dir);
    const transcriptPath = norm(dir) + "/transcript.md";
    const content = `# Scene ${this.scene.sceneNumber}\n\n${this.scene.transcript.join("\n\n")}\n`;
    await this.fileIO.writeFile(transcriptPath, content);
  }

  private writeCriticalFile(path: string, content: string): Promise<void> {
    return this.fileIO.writeFileAtomic
      ? this.fileIO.writeFileAtomic(path, content)
      : this.fileIO.writeFile(path, content);
  }

  private async savePendingOp(): Promise<void> {
    const path = norm(this.state.campaignRoot) + "/pending-operation.json";
    await this.writeCriticalFile(path, JSON.stringify(this.pendingOp, null, 2));
  }

  private async clearPendingOp(): Promise<void> {
    this.pendingOp = null;
    const path = norm(this.state.campaignRoot) + "/pending-operation.json";
    if (this.fileIO.deleteFile) {
      try {
        await this.fileIO.deleteFile(path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | null)?.code;
        if (code !== "ENOENT") throw e;
      }
    } else {
      await this.fileIO.writeFile(path, "");
    }
  }

  private async listEntityFiles(): Promise<string[]> {
    const store = await getCampaignKnowledge(this.state.campaignRoot, this.fileIO);
    const identities: string[] = [];
    for (const entry of await store.outline()) {
      if (entry.kind !== "entity") continue;
      const node = await store.read(entry.uid, { textLimit: 0, logLimit: 0 });
      identities.push(`${node.uid} = ${node.name}${node.aliases.length ? ` (aliases: ${node.aliases.join(", ")})` : ""}`);
    }
    return identities;
  }

  /** Get active objective summaries for the DM context. */
  private getActiveObjectives(): string[] {
    return Object.values(this.state.objectives.objectives)
      .filter((o) => o.status === "active")
      .map((o) => `${o.id}: ${o.title} — ${o.description}`);
  }



}

// --- Standalone detection (runs before SceneManager exists) ---

/**
 * Detect the latest scene/session numbers from a campaign directory.
 * Used during resume to reconstruct SceneState without an active SceneManager.
 */
export function isSceneIdentity(value: unknown): value is Pick<SceneState, "sceneNumber" | "slug"> & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return Number.isSafeInteger(identity.sceneNumber) && (identity.sceneNumber as number) >= 1 &&
    typeof identity.slug === "string" && !/[\\/]/.test(identity.slug) && !identity.slug.includes("\0");
}
export async function detectSceneState(campaignRoot: string, io: FileIO): Promise<SceneState> {
  const paths = campaignPaths(campaignRoot);
  const scenesDir = join(campaignRoot, "campaign", "scenes");
  const recapsDir = join(campaignRoot, "campaign", "session-recaps");

  let maxScene = 0;
  let lastSlug = "opening";
  const transcripts = new Map<number, string>();
  try {
    const entries = await io.listDir(scenesDir);
    for (const entry of entries) {
      const match = entry.match(/^(\d+)-(.+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        // Skip ghost directories left behind by rollback (no transcript.md)
        const tPath = paths.sceneTranscript(n, match[2]);
        if (await io.exists(tPath)) {
          transcripts.set(n, match[2]);
          if (n > maxScene) { maxScene = n; lastSlug = match[2]; }
        }
      }
    }
  } catch { /* no scenes dir yet */ }

  let maxSession = 0;
  try {
    const entries = await io.listDir(recapsDir);
    for (const entry of entries) {
      const match = entry.match(/^session-(\d+)\.md$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxSession) maxSession = n;
      }
    }
  } catch { /* no recaps dir yet */ }

  const readObject = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const value: unknown = JSON.parse(await io.readFile(path));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; }
  };
  const saved = await readObject(join(campaignRoot, "state", "scene.json"));
  const pending = await readObject(join(campaignRoot, "pending-operation.json"));
  const pendingNumber = pending?.sceneNumber;
  const hasPending = Number.isSafeInteger(pendingNumber) && (pendingNumber as number) >= 1 &&
    (pending?.type === "scene_transition" || pending?.type === "session_end") && typeof pending.step === "string";
  let current = Math.max(1, maxScene);
  let currentSlug = maxScene > 0 ? lastSlug : "opening";
  if (isSceneIdentity(saved)) {
    current = saved.sceneNumber;
    currentSlug = saved.slug;
  }
  if (hasPending) {
    const source = pendingNumber as number;
    // Only a durably saved successor is already advanced. A done marker with
    // the old identity still resumes from source so finishSceneAdvance resets
    // old reads/conversation and builds the next anchor before saving it.
    current = isSceneIdentity(saved) && saved.sceneNumber === source + 1 ? source + 1 : source;
    currentSlug = isSceneIdentity(saved) && saved.sceneNumber === current ? saved.slug : transcripts.get(current) ?? "";
  } else if (!isSceneIdentity(saved) && !pending && maxScene > 0) {
    // Earlier format-2 saves omitted identity. Infer only a completed cut with
    // no active conversation; already resumed/extended transcripts are ambiguous.
    let emptyConversation = false;
    try { const conversation: unknown = JSON.parse(await io.readFile(join(campaignRoot, "state", "conversation.json"))); emptyConversation = Array.isArray(conversation) && conversation.length === 0; } catch { /* no proof */ }
    const log = await readObject(paths.log);
    const completed = Array.isArray(log?.entries) && log.entries.some((entry: unknown) => entry && typeof entry === "object" && (entry as { sceneNumber?: unknown }).sceneNumber === maxScene);
    if (emptyConversation && completed && await io.exists(paths.sceneSummary(maxScene, lastSlug))) {
      current = maxScene + 1;
      currentSlug = "";
    }
  }
  let transcript: string[] = [];
  if (transcripts.get(current) === (currentSlug || "untitled")) {
    try {
      const tPath = paths.sceneTranscript(current, currentSlug || "untitled");
      const raw = await io.readFile(tPath);
      transcript = parseTranscriptEntries(raw);
    } catch { /* no transcript yet */ }
  }

  return {
    sceneNumber: current,
    slug: currentSlug,
    ...(typeof saved?.knowledgeSnapshot === "string" && saved.knowledgeSnapshotScene === current ? { knowledgeSnapshot: saved.knowledgeSnapshot, knowledgeSnapshotScene: current } : {}),
    transcript,
    precis: "",
    openThreads: "",
    npcIntents: "",
    playerReads: [],
    sessionNumber: maxSession + 1,
    sessionRecapPending: false,
  };
}

// --- Helpers ---

/**
 * Build a brief scene-opening anchor from the previous scene's campaign log entry.
 * Seeded into precis after a transition so the DM has compact context for where
 * the story left off, even before any exchanges are dropped.
 */
export function buildSceneAnchor(
  title: string,
  campaignLogEntry: string,
  alarmsFired: string[],
): string {
  const lines: string[] = [];
  if (campaignLogEntry) {
    const bullets = campaignLogEntry
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    // Last 3 bullets describe where the previous scene ended = where we are now
    const tail = bullets.slice(-3);
    if (tail.length > 0) {
      lines.push(`Previous scene (${title}):`);
      lines.push(...tail);
      lines.push("The Campaign Log and campaign knowledge carry the engine's distilled record of all prior scenes — that record is authoritative.");
    }
  }
  if (alarmsFired.length > 0) {
    lines.push("Alarms fired during transition:");
    for (const alarm of alarmsFired) {
      lines.push(`- ${alarm}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse a transcript.md file into the original entry array.
 * Entries start with known prefixes (**[, **DM:**, > `). Paragraphs
 * without a prefix are continuation of the previous entry (DM responses
 * can contain \n\n paragraph breaks). This is the inverse of the
 * join("\n\n") used in finalizeTranscript.
 */
export function parseTranscriptEntries(raw: string): string[] {
  const entryPrefix = /^(\*\*\[|\*\*DM:\*\*|> `)/;
  const paragraphs = raw.split("\n\n").filter((b) => b.trim().length > 0);
  const entries: string[] = [];

  for (const para of paragraphs) {
    // Trim leading whitespace so that extra \n from DM responses
    // (which produce \n\n\n when joined) don't hide entry prefixes.
    const trimmed = para.trimStart();
    if (trimmed.startsWith("# Scene")) continue;
    if (entryPrefix.test(trimmed) || entries.length === 0) {
      entries.push(trimmed);
    } else {
      // Continuation paragraph — merge back into previous entry
      entries[entries.length - 1] += "\n\n" + trimmed;
    }
  }

  return entries;
}

/**
 * Classify a transcript entry by its prefix and return the appropriate
 * NarrativeLine kind plus cleaned text.
 *
 * - `**DM:** ...`     → kind "dm", prefix stripped
 * - `**[Name]** ...`  → kind "player", formatted as "> Name: ..."
 * - `` > `tool`: ...``→ kind "dev", kept as-is
 * - anything else     → kind "dm", kept as-is (continuation text)
 */
export function classifyTranscriptEntry(entry: string): { kind: "dm" | "player" | "dev"; text: string } {
  if (entry.startsWith("**DM:** ")) {
    return { kind: "dm", text: entry.slice("**DM:** ".length) };
  }
  // Also handle **DM:** with no space after (edge case)
  if (entry.startsWith("**DM:**")) {
    return { kind: "dm", text: entry.slice("**DM:**".length) };
  }
  const playerMatch = entry.match(/^\*\*\[(.+?)\]\*\*\s*/);
  if (playerMatch) {
    return { kind: "player", text: `> ${playerMatch[1]}: ${entry.slice(playerMatch[0].length)}` };
  }
  if (entry.startsWith("> `")) {
    return { kind: "dev", text: entry };
  }
  return { kind: "dm", text: entry };
}

/** Assemble the scene precis string from precis text, NPC intents, and open threads. */
export function buildScenePrecis(scene: SceneState): string {
  let result = scene.precis;
  if (scene.npcIntents) result += `\nNPC intents: ${scene.npcIntents}`;
  if (scene.openThreads) result += `\nOpen: ${scene.openThreads}`;
  return result;
}

/**
 * Build a raw scene-length readout for the DM prefix: exchange count and
 * open-thread count, nothing more. The DM decides what (if anything) to do
 * with it — keeping this unopinionated avoids forcing premature transitions.
 */
export function buildScenePacing(scene: SceneState): string | undefined {
  // Count player exchanges (lines starting with **[)
  const exchangeCount = scene.transcript.filter((t) => t.startsWith("**[")).length;
  if (exchangeCount === 0) return undefined;

  // Count open threads from the comma-separated list
  const threadList = scene.openThreads
    ? scene.openThreads.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  const threadCount = threadList.length;

  return `Exchanges: ${exchangeCount} | Open threads: ${threadCount}`;
}


/**
 * Synthesize accumulated player reads into a concise text block for the DM prompt.
 * Uses only the most recent read (it supersedes earlier ones).
 */
function synthesizePlayerRead(reads: PlayerRead[]): string | undefined {
  if (reads.length === 0) return undefined;
  const latest = reads[reads.length - 1];
  return `Focus: ${latest.focus.join(", ")} | Tone: ${latest.tone} | Off-script: ${latest.offScript ? "yes" : "no"}`;
}

/**
 * Read machine-scope player files and aggregate content boundaries.
 * Returns combined boundaries for all active players, or undefined if none.
 */
export async function loadContentBoundaries(
  players: { name: string }[],
  homeDir: string,
  fileIO: FileIO,
): Promise<string | undefined> {
  const mPaths = machinePaths(homeDir);
  const parts: string[] = [];
  for (const player of players) {
    const slug = slugify(player.name);
    const path = norm(mPaths.player(slug));
    try {
      const content = await fileIO.readFile(path);
      const { body } = parseFrontMatter(content);
      const section = extractSection(body, "Content Boundaries");
      if (section) {
        parts.push(players.length > 1 ? `${player.name}:\n${section}` : section);
      }
    } catch { /* player file doesn't exist yet */ }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
