import type Anthropic from "@anthropic-ai/sdk";
import type { GameState } from "./game-state.js";
import type { ConversationManager, DroppedExchange } from "../context/index.js";
import { buildDMPrefix, buildActiveState } from "./dm-prompt.js";
import type { DMSessionState } from "./dm-prompt.js";
import { summarizeScene } from "./subagents/scene-summarizer.js";
import { updatePrecis } from "./subagents/precis-updater.js";
import type { PlayerRead } from "./subagents/precis-updater.js";
import { updateChangelogs } from "./subagents/changelog-updater.js";
import { advanceCalendar, checkClocks } from "../tools/clocks/index.js";
import { validateCampaign } from "../tools/validation/index.js";
import type { ValidationResult } from "../tools/validation/index.js";
import { join } from "node:path";
import { sceneDir, campaignPaths } from "../tools/filesystem/index.js";
import { formatChangelogEntry, appendChangelog } from "../tools/filesystem/index.js";
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
  playerReads: PlayerRead[];
  sessionNumber: number;
}

export type PendingStep =
  | "finalize_transcript"
  | "campaign_log"
  | "changelog_updates"
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
}

/** Ordered cascade steps for scene transitions. Used for resume logic. */
const STEP_ORDER: PendingStep[] = [
  "finalize_transcript", "campaign_log", "changelog_updates",
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
  }

  /** Get the current system prompt (cached prefix) */
  getSystemPrompt(): Anthropic.TextBlockParam[] {
    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.state.config.players.map((p) => p.character),
      pendingAlarms: [],
      turnHolder: undefined,
    });
    this.sessionState.scenePrecis = this.scene.precis;
    this.sessionState.playerRead = synthesizePlayerRead(this.scene.playerReads);
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

    this.devLog?.("[dev] subagent:precis-updater starting");
    const result = await updatePrecis(client, this.scene.precis, exchangeText);
    this.devLog?.("[dev] subagent:precis-updater done");
    this.scene.precis += "\n" + result.text;
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

    // Step 2: Campaign log entry (Haiku)
    this.pendingOp.step = "campaign_log";
    await this.savePendingOp();
    await this.stepCampaignLog(client, title, result);

    // Step 3: Entity changelog updates (Haiku)
    this.pendingOp.step = "changelog_updates";
    await this.savePendingOp();
    await this.stepChangelogUpdates(client, result);

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
    // Already done or unknown step — clear and bail
    const startIdx = STEP_ORDER.indexOf(pendingOp.step);
    if (pendingOp.step === "done" || startIdx === -1) {
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
        case "campaign_log": await this.stepCampaignLog(client, pendingOp.title, result); break;
        case "changelog_updates": await this.stepChangelogUpdates(client, result); break;
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

    return result;
  }

  /**
   * Resume a session: load campaign state, build prefix, return recap.
   * Returns the session recap text for display in a modal.
   */
  async sessionResume(): Promise<string> {
    const paths = campaignPaths(this.state.campaignRoot);

    // Try to load session recap
    const recapPath = paths.sessionRecap(this.scene.sessionNumber - 1);
    let recap = "";
    if (await this.fileIO.exists(recapPath)) {
      recap = await this.fileIO.readFile(recapPath);
    }

    // Load campaign log for summary
    if (await this.fileIO.exists(paths.log)) {
      this.sessionState.campaignSummary = await this.fileIO.readFile(paths.log);
    }

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

    return recap;
  }

  /** Context refresh: re-read campaign log, session recap, rebuild active state */
  async contextRefresh(): Promise<void> {
    const root = this.state.campaignRoot;
    const paths = campaignPaths(root);

    // Re-read campaign log
    try {
      if (await this.fileIO.exists(paths.log)) {
        this.sessionState.campaignSummary = await this.fileIO.readFile(paths.log);
      }
    } catch { /* non-critical */ }

    // Re-read previous session recap
    try {
      const recapPath = paths.sessionRecap(this.scene.sessionNumber - 1);
      if (await this.fileIO.exists(recapPath)) {
        this.sessionState.sessionRecap = await this.fileIO.readFile(recapPath);
      }
    } catch { /* non-critical */ }

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
      pcSummaries: this.state.config.players.map((p) => p.character),
      pendingAlarms,
    });

    // Sync precis and player read
    this.sessionState.scenePrecis = this.scene.precis;
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

  // --- Transition step methods ---

  private async stepFinalizeTranscript(): Promise<void> {
    await this.finalizeTranscript();
  }

  private async stepCampaignLog(
    client: Anthropic,
    title: string,
    result: TransitionResult,
  ): Promise<void> {
    const transcript = this.scene.transcript.join("\n");
    this.devLog?.("[dev] subagent:summarizer starting");
    const summaryResult = await summarizeScene(client, transcript);
    this.devLog?.("[dev] subagent:summarizer done");
    result.campaignLogEntry = summaryResult.text;
    accUsage(result.usage, summaryResult.usage);

    const paths = campaignPaths(this.state.campaignRoot);
    const logEntry = `\n## Scene ${this.scene.sceneNumber}: ${title}\n${result.campaignLogEntry}\n`;
    await this.fileIO.appendFile(paths.log, logEntry);
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
    this.scene.playerReads = [];
  }

  private stepPruneContext(): void {
    this.conversation.clear();
  }

  private async stepCheckpoint(): Promise<void> {
    await this.repo?.sceneCommit(this.pendingOp?.title ?? "untitled");
  }

  // --- Internal ---

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
    const dirs = ["characters", "locations", "factions", "lore"];
    const files: string[] = [];
    for (const dir of dirs) {
      const dirPath = `${this.state.campaignRoot}/${dir}`;
      if (await this.fileIO.exists(dirPath)) {
        const entries = await this.fileIO.listDir(dirPath);
        files.push(...entries.filter((f) => f.endsWith(".md")));
      }
    }
    return files;
  }

  private async appendEntityChangelog(
    filename: string,
    sceneNumber: number,
    description: string,
  ): Promise<void> {
    // Find the entity file in common directories
    const dirs = ["characters", "locations", "factions", "lore"];
    for (const dir of dirs) {
      const path = `${this.state.campaignRoot}/${dir}/${filename}`;
      if (await this.fileIO.exists(path)) {
        const content = await this.fileIO.readFile(path);
        const entry = formatChangelogEntry(sceneNumber, description);
        const updated = appendChangelog(content, entry);
        await this.fileIO.writeFile(path, updated);
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
        if (n > maxScene) {
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
    playerReads: [],
    sessionNumber: maxSession + 1,
  };
}

// --- Helpers ---

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
    if (para.startsWith("# Scene")) continue;
    if (entryPrefix.test(para) || entries.length === 0) {
      entries.push(para);
    } else {
      // Continuation paragraph — merge back into previous entry
      entries[entries.length - 1] += "\n\n" + para;
    }
  }

  return entries;
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
