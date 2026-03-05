import type Anthropic from "@anthropic-ai/sdk";
import type { GameState } from "./game-state.js";
import type { ConversationManager, DroppedExchange } from "../context/index.js";
import { renderCampaignLog, parseLegacyLog } from "../context/index.js";
import type { CampaignLog, CampaignLogEntry } from "../context/index.js";
import { buildDMPrefix, buildActiveState } from "./dm-prompt.js";
import type { DMSessionState } from "./dm-prompt.js";
import { summarizeScene } from "./subagents/scene-summarizer.js";
import { generateNarrativeRecap } from "./subagents/narrative-recap.js";
import { updatePrecis } from "./subagents/precis-updater.js";
import type { PlayerRead } from "./subagents/precis-updater.js";
import { updateChangelogs } from "./subagents/changelog-updater.js";
import { advanceCalendar, checkClocks } from "../tools/clocks/index.js";
import { validateCampaign } from "../tools/validation/index.js";
import type { ValidationResult } from "../tools/validation/index.js";
import { join } from "node:path";
import { sceneDir, campaignPaths, parseFrontMatter } from "../tools/filesystem/index.js";
import { formatChangelogEntry, appendChangelog } from "../tools/filesystem/index.js";
import { slugify } from "./world-builder.js";
import type { UsageStats } from "./agent-loop.js";
import { accUsage } from "../context/usage-helpers.js";
import { norm } from "../utils/paths.js";
import type { CampaignRepo } from "../tools/git/index.js";

// --- Types ---

export interface SceneState {
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
export interface FileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  deleteFile?(path: string): Promise<void>;
  /** Remove an empty directory. Rejects if the directory is not empty. */
  rmdir?(path: string): Promise<void>;
}

/** Ordered cascade steps for scene transitions. Used for resume logic. */
const STEP_ORDER: PendingStep[] = [
  "finalize_transcript", "subagent_updates",
  "advance_calendar", "check_alarms", "validate",
  "reset_precis", "prune_context", "checkpoint", "done",
];

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
  private sceneEntityIndex = new Map<string, { name: string; aliases?: string }>();

  /** Optional dev mode log callback. */
  devLog?: (msg: string) => void;

  constructor(
    state: GameState,
    scene: SceneState,
    conversation: ConversationManager,
    sessionState: DMSessionState,
    fileIO: FileIO,
    repo?: CampaignRepo,
  ) {
    this.state = state;
    this.scene = scene;
    this.conversation = conversation;
    this.sessionState = sessionState;
    this.fileIO = fileIO;
    this.repo = repo ?? null;
    this.pcSummaries = state.config.players.map((p) => p.character);
  }

  /** Get the current system prompt (cached prefix) */
  getSystemPrompt(): Anthropic.TextBlockParam[] {
    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.pcSummaries,
      pendingAlarms: [],
      turnHolder: undefined,
    });
    this.sessionState.scenePrecis = buildScenePrecis(this.scene);
    this.sessionState.playerRead = synthesizePlayerRead(this.scene.playerReads);
    this.sessionState.entityIndex = this.buildSceneEntityIndex();
    return buildDMPrefix(this.state.config, this.sessionState);
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
    client: Anthropic,
    dropped: DroppedExchange,
  ): Promise<UsageStats> {
    // Format the dropped exchange as text
    const userContent = typeof dropped.exchange.user.content === "string"
      ? dropped.exchange.user.content
      : "[complex content]";
    const assistantContent = typeof dropped.exchange.assistant.content === "string"
      ? dropped.exchange.assistant.content
      : "[complex content]";
    const exchangeText = `Player: ${userContent}\nDM: ${assistantContent}`;

    const pcIdent = this.state.config.players
      .map((p) => `[[${p.character}]] (${p.name})`)
      .join(", ");

    this.devLog?.("[dev] subagent:precis-updater starting");
    const result = await updatePrecis(
      client, this.scene.precis, exchangeText,
      this.scene.openThreads || undefined,
      pcIdent,
      this.aliasContext || undefined,
      this.scene.npcIntents || undefined,
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

  /**
   * Execute the scene_transition cascade.
   * Each step is tracked in pendingOp for idempotent recovery.
   */
  async sceneTransition(
    client: Anthropic,
    title: string,
    timeAdvance?: number,
  ): Promise<TransitionResult> {
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
    await this.stepSubagentUpdates(client, title, result);

    // Step 4: Advance calendar
    this.pendingOp.step = "advance_calendar";
    await this.savePendingOp();
    this.stepAdvanceCalendar(timeAdvance, result);

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
    this.stepResetPrecis();

    // Step 7: Prune context
    this.pendingOp.step = "prune_context";
    this.stepPruneContext();

    // Step 8: Checkpoint (git commit would go here)
    this.pendingOp.step = "checkpoint";
    await this.savePendingOp();
    await this.stepCheckpoint();

    // Done
    this.pendingOp.step = "done";
    await this.clearPendingOp();

    // Advance scene number for next scene
    this.scene.sceneNumber++;
    this.scene.slug = "";
    this.scene.transcript = [];

    // Seed precis with an anchor so the DM has context before any exchanges drop
    this.scene.precis = buildSceneAnchor(title, result.campaignLogEntry, result.alarmsFired);

    return result;
  }

  /** End the session: final scene transition + session recap */
  async sessionEnd(
    client: Anthropic,
    title: string,
    timeAdvance?: number,
  ): Promise<TransitionResult> {
    const result = await this.sceneTransition(client, title, timeAdvance);

    // Write session recap
    const paths = campaignPaths(this.state.campaignRoot);
    const recapPath = paths.sessionRecap(this.scene.sessionNumber);
    await this.fileIO.writeFile(recapPath, `# Session ${this.scene.sessionNumber} Recap\n\n${result.campaignLogEntry}\n`);

    // Generate narrative recap for the "Previously on..." modal
    try {
      const narrativeResult = await generateNarrativeRecap(
        client,
        result.campaignLogEntry,
        this.state.config.name,
      );
      await this.fileIO.writeFile(
        paths.sessionRecapNarrative(this.scene.sessionNumber),
        narrativeResult.text,
      );
      accUsage(result.usage, narrativeResult.usage);
    } catch {
      // Non-critical — bullet recap still exists for fallback
    }

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
    client: Anthropic,
    pendingOp: PendingOperation,
  ): Promise<TransitionResult | null> {
    // Normalize legacy step names from before subagent parallelization
    let effectiveStep = pendingOp.step as string;
    if (effectiveStep === "campaign_log" || effectiveStep === "changelog_updates") {
      effectiveStep = "subagent_updates";
    }

    // Already done or unknown step — clear and bail
    const startIdx = STEP_ORDER.indexOf(effectiveStep as PendingStep);
    if (effectiveStep === "done" || startIdx === -1) {
      await this.clearPendingOp();
      return null;
    }

    this.pendingOp = { ...pendingOp };

    const totalUsage: UsageStats = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    const result: TransitionResult = {
      campaignLogEntry: "",
      changelogEntries: [],
      alarmsFired: [],
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
        case "subagent_updates": await this.stepSubagentUpdates(client, pendingOp.title, result); break;
        case "advance_calendar": this.stepAdvanceCalendar(pendingOp.timeAdvance, result); break;
        case "check_alarms": this.stepCheckAlarms(); break;
        case "validate": result.validationIssues = await this.stepValidate(); break;
        case "reset_precis": this.stepResetPrecis(); break;
        case "prune_context": this.stepPruneContext(); break;
        case "checkpoint": await this.stepCheckpoint(); break;
      }
    }

    await this.clearPendingOp();

    // Advance scene for next scene
    this.scene.sceneNumber++;
    this.scene.slug = "";
    this.scene.transcript = [];

    // Seed precis with an anchor so the DM has context before any exchanges drop
    this.scene.precis = buildSceneAnchor(
      pendingOp.title,
      result.campaignLogEntry,
      result.alarmsFired,
    );

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

    // Load campaign log — migrate from legacy log.md if needed
    this.sessionState.campaignSummary = await this.loadAndRenderCampaignLog();

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

    // Return narrative recap for player display, fall back to bullet recap
    return narrativeRecap || recap;
  }

  /** Context refresh: re-read campaign log, session recap, rebuild active state */
  async contextRefresh(): Promise<void> {
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

    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.pcSummaries,
      pendingAlarms,
    });

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

  /**
   * Record that an entity was created or updated this scene.
   * Called by GameEngine after successful entity file writes.
   */
  notifyEntityTouched(filePath: string, name: string, aliases?: string): void {
    // Compute relative path from campaignRoot
    const normalizedPath = norm(filePath);
    const normalizedRoot = norm(this.state.campaignRoot);
    const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
    const relativePath = normalizedPath.startsWith(prefix)
      ? normalizedPath.slice(prefix.length)
      : normalizedPath;
    this.sceneEntityIndex.set(relativePath, { name, aliases: aliases || undefined });
  }

  // --- Campaign log loading ---

  /**
   * Load campaign log JSON, migrating from legacy log.md if needed,
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
      } catch { /* corrupt JSON — try legacy */ }
    }

    // Migrate from legacy log.md
    if (await this.fileIO.exists(paths.legacyLog)) {
      try {
        const md = await this.fileIO.readFile(paths.legacyLog);
        const log = parseLegacyLog(md);
        // Persist the migration
        await this.fileIO.writeFile(paths.log, JSON.stringify(log, null, 2));
        this.devLog?.("[dev] migrated campaign/log.md → campaign/log.json");
        return renderCampaignLog(log, budget);
      } catch { /* non-critical */ }
    }

    return "";
  }

  // --- Transition step methods ---

  private async stepFinalizeTranscript(): Promise<void> {
    await this.finalizeTranscript();
  }

  private async stepSubagentUpdates(
    client: Anthropic,
    title: string,
    result: TransitionResult,
  ): Promise<void> {
    await Promise.all([
      this.stepCampaignLog(client, title, result),
      this.stepChangelogUpdates(client, result),
    ]);
  }

  private async stepCampaignLog(
    client: Anthropic,
    title: string,
    result: TransitionResult,
  ): Promise<void> {
    const transcript = this.scene.transcript.join("\n");
    this.devLog?.("[dev] subagent:summarizer starting");
    const summaryResult = await summarizeScene(client, transcript, this.aliasContext || undefined);
    this.devLog?.("[dev] subagent:summarizer done");
    // campaignLogEntry stays as full text for buildSceneAnchor, session recaps, etc.
    result.campaignLogEntry = summaryResult.full;
    accUsage(result.usage, summaryResult.usage);

    const paths = campaignPaths(this.state.campaignRoot);

    // Read existing log.json or create empty
    let log: CampaignLog;
    try {
      if (await this.fileIO.exists(paths.log)) {
        log = JSON.parse(await this.fileIO.readFile(paths.log)) as CampaignLog;
      } else {
        log = { campaignName: this.state.config.name, entries: [] };
      }
    } catch {
      log = { campaignName: this.state.config.name, entries: [] };
    }

    // Build and push entry
    const entry: CampaignLogEntry = {
      sceneNumber: this.scene.sceneNumber,
      title,
      full: summaryResult.full,
      mini: summaryResult.mini,
    };
    log.entries.push(entry);

    // Write updated log.json
    await this.fileIO.writeFile(paths.log, JSON.stringify(log, null, 2));

    // Write per-scene summary file
    const summaryPath = paths.sceneSummary(
      this.scene.sceneNumber,
      this.scene.slug || "untitled",
    );
    await this.fileIO.writeFile(summaryPath, summaryResult.full);
  }

  private async stepChangelogUpdates(
    client: Anthropic,
    result: TransitionResult,
  ): Promise<void> {
    const entityFiles = await this.listEntityFiles();
    if (entityFiles.length === 0) return;

    const transcript = this.scene.transcript.join("\n");
    this.devLog?.(`[dev] subagent:changelog starting (${entityFiles.length} entities)`);
    const changelogResult = await updateChangelogs(
      client,
      transcript,
      this.scene.sceneNumber,
      entityFiles,
      this.aliasContext || undefined,
    );
    accUsage(result.usage, changelogResult.usage);
    this.devLog?.("[dev] subagent:changelog done");
    result.changelogEntries = parseChangelogEntries(changelogResult.text);

    for (const entry of result.changelogEntries) {
      const [filename, ...rest] = entry.split(": ");
      const entryText = rest.join(": ");
      if (filename && entryText) {
        await this.appendEntityChangelog(
          filename.trim(),
          this.scene.sceneNumber,
          entryText.trim(),
        );
      }
    }
  }

  private stepAdvanceCalendar(
    timeAdvance: number | undefined,
    result: TransitionResult,
  ): void {
    if (timeAdvance && timeAdvance > 0) {
      const fired = advanceCalendar(this.state.clocks, timeAdvance);
      result.alarmsFired = fired.map((a) => a.message);
    }
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

  private stepResetPrecis(): void {
    this.scene.precis = "";
    this.scene.openThreads = "";
    this.scene.npcIntents = "";
    this.scene.playerReads = [];
    this.sceneEntityIndex.clear();
  }

  private stepPruneContext(): void {
    this.conversation.clear();
  }

  private async stepCheckpoint(): Promise<void> {
    await this.repo?.sceneCommit(this.pendingOp?.title ?? "untitled");
  }

  // --- Internal ---

  /**
   * Collect all entity file paths across entity directories.
   * Handles both flat files (characters/, factions/, lore/) and
   * subdirectory entries (locations/<slug>/index.md).
   * Returns entries as `{ dir, file, fullPath }`.
   */
  private async collectEntityFiles(): Promise<{ dir: string; file: string; fullPath: string }[]> {
    const dirs = ["characters", "locations", "factions", "lore"];
    const results: { dir: string; file: string; fullPath: string }[] = [];
    for (const dir of dirs) {
      const dirPath = `${this.state.campaignRoot}/${dir}`;
      try {
        if (!(await this.fileIO.exists(dirPath))) continue;
        const entries = await this.fileIO.listDir(dirPath);
        for (const entry of entries) {
          if (entry.endsWith(".md")) {
            results.push({ dir, file: entry, fullPath: `${dirPath}/${entry}` });
          } else {
            // Could be a subdirectory (locations use slug/index.md)
            const indexPath = `${dirPath}/${entry}/index.md`;
            if (await this.fileIO.exists(indexPath)) {
              results.push({ dir, file: `${entry}/index.md`, fullPath: indexPath });
            }
          }
        }
      } catch { /* non-critical — skip dir */ }
    }
    return results;
  }

  private async loadPCSummaries(): Promise<string[]> {
    const root = this.state.campaignRoot;
    const paths = campaignPaths(root);
    const summaries: string[] = [];
    for (const player of this.state.config.players) {
      const slug = slugify(player.character);
      const filePath = paths.character(slug);
      let line = player.character;
      try {
        if (await this.fileIO.exists(filePath)) {
          const raw = await this.fileIO.readFile(filePath);
          const { frontMatter } = parseFrontMatter(raw);
          const rawAliases = frontMatter.additional_names;
          const aliases = Array.isArray(rawAliases) ? rawAliases.join(", ") : typeof rawAliases === "string" ? rawAliases : undefined;
          if (aliases?.trim()) {
            line += ` (also: ${aliases.trim()})`;
          }
        }
      } catch { /* non-critical — fall back to bare name */ }
      summaries.push(line);
    }
    return summaries;
  }

  private async buildAliasContext(): Promise<string> {
    const entityFiles = await this.collectEntityFiles();
    const lines: string[] = [];
    for (const { file, fullPath } of entityFiles) {
      try {
        const raw = await this.fileIO.readFile(fullPath);
        const { frontMatter } = parseFrontMatter(raw);
        const rawAliases = frontMatter.additional_names;
        const aliases = Array.isArray(rawAliases) ? rawAliases.join(", ") : typeof rawAliases === "string" ? rawAliases : undefined;
        if (aliases?.trim()) {
          lines.push(`${file}: also known as ${aliases.trim()}`);
        }
      } catch { /* non-critical */ }
    }
    return lines.length > 0
      ? `\n\nEntity aliases (use canonical filename in wikilinks, not the alias):\n${lines.join("\n")}`
      : "";
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

  private async savePendingOp(): Promise<void> {
    const path = norm(this.state.campaignRoot) + "/pending-operation.json";
    await this.fileIO.writeFile(path, JSON.stringify(this.pendingOp, null, 2));
  }

  private async clearPendingOp(): Promise<void> {
    this.pendingOp = null;
    const path = norm(this.state.campaignRoot) + "/pending-operation.json";
    await this.fileIO.writeFile(path, "");
  }

  private async listEntityFiles(): Promise<string[]> {
    const entityFiles = await this.collectEntityFiles();
    return entityFiles.map((e) => e.file);
  }

  /**
   * Build a compact entity index string for the DM prefix.
   * Returns undefined if no entities have been touched this scene.
   */
  private buildSceneEntityIndex(): string | undefined {
    if (this.sceneEntityIndex.size === 0) return undefined;
    const lines: string[] = ["Entities created/updated this scene — update these, do not create duplicates:"];
    for (const [path, { name, aliases }] of this.sceneEntityIndex) {
      const suffix = aliases ? ` (also: ${aliases})` : "";
      lines.push(`  ${path} — ${name}${suffix}`);
    }
    return lines.join("\n");
  }

  private async appendEntityChangelog(
    filename: string,
    sceneNumber: number,
    description: string,
  ): Promise<void> {
    // Find the entity file — check both flat path and subdirectory index.md
    const dirs = ["characters", "locations", "factions", "lore"];
    for (const dir of dirs) {
      const sceneTag = `Scene ${String(sceneNumber).padStart(3, "0")}`;
      const flatPath = `${this.state.campaignRoot}/${dir}/${filename}`;
      if (await this.fileIO.exists(flatPath)) {
        const content = await this.fileIO.readFile(flatPath);
        if (content.includes(sceneTag)) return; // idempotency guard
        const entry = formatChangelogEntry(sceneNumber, description);
        const updated = appendChangelog(content, entry);
        await this.fileIO.writeFile(flatPath, updated);
        return;
      }
      // Try subdirectory pattern (e.g. locations/slug/index.md)
      const slug = filename.replace(/\.md$/, "");
      const indexPath = `${this.state.campaignRoot}/${dir}/${slug}/index.md`;
      if (await this.fileIO.exists(indexPath)) {
        const content = await this.fileIO.readFile(indexPath);
        if (content.includes(sceneTag)) return; // idempotency guard
        const entry = formatChangelogEntry(sceneNumber, description);
        const updated = appendChangelog(content, entry);
        await this.fileIO.writeFile(indexPath, updated);
        return;
      }
    }
  }
}

// --- Standalone detection (runs before SceneManager exists) ---

/**
 * Detect the latest scene/session numbers from a campaign directory.
 * Used during resume to reconstruct SceneState without an active SceneManager.
 */
export async function detectSceneState(campaignRoot: string, io: FileIO): Promise<SceneState> {
  const paths = campaignPaths(campaignRoot);
  const scenesDir = join(campaignRoot, "campaign", "scenes");
  const recapsDir = join(campaignRoot, "campaign", "session-recaps");

  let maxScene = 0;
  let lastSlug = "opening";
  try {
    const entries = await io.listDir(scenesDir);
    for (const entry of entries) {
      const match = entry.match(/^(\d+)-(.+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        // Skip ghost directories left behind by rollback (no transcript.md)
        const tPath = paths.sceneTranscript(n, match[2]);
        if (n > maxScene && await io.exists(tPath)) {
          maxScene = n;
          lastSlug = match[2];
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

  let transcript: string[] = [];
  if (maxScene > 0) {
    try {
      const tPath = paths.sceneTranscript(maxScene, lastSlug);
      const raw = await io.readFile(tPath);
      transcript = parseTranscriptEntries(raw);
    } catch { /* no transcript yet */ }
  }

  return {
    sceneNumber: Math.max(1, maxScene),
    slug: maxScene > 0 ? lastSlug : "opening",
    transcript,
    precis: "",
    openThreads: "",
    npcIntents: "",
    playerReads: [],
    sessionNumber: maxSession + 1,
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

/**
 * Build a terse scene-pacing signal for the DM prefix.
 * Gives the DM concrete data to evaluate scene ripeness:
 * exchange count, open thread count, and whether any threads
 * have been resolved (precis updates happened but thread count stayed or dropped).
 */
/** Assemble the scene precis string from precis text, NPC intents, and open threads. */
export function buildScenePrecis(scene: SceneState): string {
  let result = scene.precis;
  if (scene.npcIntents) result += `\nNPC intents: ${scene.npcIntents}`;
  if (scene.openThreads) result += `\nOpen: ${scene.openThreads}`;
  return result;
}

export function buildScenePacing(scene: SceneState): string | undefined {
  // Count player exchanges (lines starting with **[)
  const exchangeCount = scene.transcript.filter((t) => t.startsWith("**[")).length;
  if (exchangeCount === 0) return undefined;

  // Count open threads from the comma-separated list
  const threadList = scene.openThreads
    ? scene.openThreads.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  const threadCount = threadList.length;

  const parts: string[] = [`Exchanges: ${exchangeCount}`];
  parts.push(`Open threads: ${threadCount}`);

  // Advisory nudge when the scene is running long or overloaded
  if (exchangeCount >= 8 && threadCount >= 3) {
    parts.push("→ Scene is long and thread-heavy. Consider ending it — unresolved threads carry forward, and your alarms and clocks need a transition to fire.");
  } else if (exchangeCount >= 10) {
    parts.push("→ Scene is running long. Look for a cut point.");
  } else if (threadCount >= 4) {
    parts.push("→ Many open threads. Resolve or cut — don't open more.");
  }

  return parts.join(" | ");
}

function parseChangelogEntries(text: string): string[] {
  return text.split("\n").filter((line) => line.includes(":")).map((line) => line.trim());
}

/**
 * Synthesize accumulated player reads into a concise text block for the DM prompt.
 * Uses only the most recent read (it supersedes earlier ones).
 */
function synthesizePlayerRead(reads: PlayerRead[]): string | undefined {
  if (reads.length === 0) return undefined;
  const latest = reads[reads.length - 1];
  return `Engagement: ${latest.engagement} | Focus: ${latest.focus.join(", ")} | Tone: ${latest.tone} | Pacing: ${latest.pacing} | Off-script: ${latest.offScript ? "yes" : "no"}`;
}
