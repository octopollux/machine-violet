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
import { sceneDir, campaignPaths } from "../tools/filesystem/index.js";
import { formatChangelogEntry, appendChangelog } from "../tools/filesystem/index.js";
import type { UsageStats } from "./agent-loop.js";

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

// --- Scene Manager ---

export class SceneManager {
  private state: GameState;
  private scene: SceneState;
  private conversation: ConversationManager;
  private sessionState: DMSessionState;
  private fileIO: FileIO;
  private pendingOp: PendingOperation | null = null;

  constructor(
    state: GameState,
    scene: SceneState,
    conversation: ConversationManager,
    sessionState: DMSessionState,
    fileIO: FileIO,
  ) {
    this.state = state;
    this.scene = scene;
    this.conversation = conversation;
    this.sessionState = sessionState;
    this.fileIO = fileIO;
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

    const result = await updatePrecis(client, this.scene.precis, exchangeText);
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

    // Save pending operation marker
    await this.savePendingOp();

    // Step 1: Finalize transcript to disk
    this.pendingOp.step = "finalize_transcript";
    await this.finalizeTranscript();

    // Step 2: Campaign log entry (Haiku)
    this.pendingOp.step = "campaign_log";
    await this.savePendingOp();
    const transcript = this.scene.transcript.join("\n");
    const summaryResult = await summarizeScene(client, transcript);
    result.campaignLogEntry = summaryResult.text;
    accUsage(totalUsage, summaryResult.usage);

    // Append to campaign log file
    const paths = campaignPaths(this.state.campaignRoot);
    const logEntry = `\n## Scene ${this.scene.sceneNumber}: ${title}\n${result.campaignLogEntry}\n`;
    await this.fileIO.appendFile(paths.log, logEntry);

    // Step 3: Entity changelog updates (Haiku)
    this.pendingOp.step = "changelog_updates";
    await this.savePendingOp();
    const entityFiles = await this.listEntityFiles();
    if (entityFiles.length > 0) {
      const changelogResult = await updateChangelogs(
        client,
        transcript,
        this.scene.sceneNumber,
        entityFiles,
      );
      accUsage(totalUsage, changelogResult.usage);
      result.changelogEntries = parseChangelogEntries(changelogResult.text);

      // Write changelog entries to entity files
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

    // Step 4: Advance calendar
    this.pendingOp.step = "advance_calendar";
    await this.savePendingOp();
    if (timeAdvance && timeAdvance > 0) {
      const fired = advanceCalendar(this.state.clocks, timeAdvance);
      result.alarmsFired = fired.map((a) => a.message);
    }

    // Step 5: Check alarms
    this.pendingOp.step = "check_alarms";
    await this.savePendingOp();
    checkClocks(this.state.clocks);

    // Step 6: Reset precis and player reads
    this.pendingOp.step = "reset_precis";
    this.scene.precis = "";
    this.scene.playerReads = [];

    // Step 7: Prune context
    this.pendingOp.step = "prune_context";
    this.conversation.clear();

    // Step 8: Checkpoint (git commit would go here)
    this.pendingOp.step = "checkpoint";
    await this.savePendingOp();

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

    return recap;
  }

  /** Context refresh: regenerate precis from transcript, re-read active state */
  async contextRefresh(): Promise<void> {
    // Precis will be regenerated from transcript on disk if needed
    // For now, just refresh the prefix
    this.sessionState.activeState = buildActiveState({
      pcSummaries: this.state.config.players.map((p) => p.character),
      pendingAlarms: [],
    });
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

  // --- Internal ---

  private async finalizeTranscript(): Promise<void> {
    const dir = sceneDir(
      this.state.campaignRoot,
      this.scene.sceneNumber,
      this.scene.slug || "untitled",
    );
    await this.fileIO.mkdir(dir);
    const transcriptPath = dir.replace(/\\/g, "/") + "/transcript.md";
    const content = `# Scene ${this.scene.sceneNumber}\n\n${this.scene.transcript.join("\n\n")}\n`;
    await this.fileIO.writeFile(transcriptPath, content);
  }

  private async savePendingOp(): Promise<void> {
    const path = this.state.campaignRoot.replace(/\\/g, "/") + "/pending-operation.json";
    await this.fileIO.writeFile(path, JSON.stringify(this.pendingOp));
  }

  private async clearPendingOp(): Promise<void> {
    this.pendingOp = null;
    const path = this.state.campaignRoot.replace(/\\/g, "/") + "/pending-operation.json";
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

// --- Helpers ---

function accUsage(total: UsageStats, add: UsageStats): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cacheReadTokens += add.cacheReadTokens;
  total.cacheCreationTokens += add.cacheCreationTokens;
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
