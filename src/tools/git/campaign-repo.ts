/**
 * Git-based state snapshots for campaign directories.
 * Wraps isomorphic-git with a campaign-specific interface.
 *
 * All commits are local-only — nothing is pushed.
 * Git is invisible infrastructure; the player never interacts with it.
 */

// --- Types ---

export type CommitType = "auto" | "scene" | "session" | "checkpoint" | "character";

export interface CommitInfo {
  oid: string;
  message: string;
  type: CommitType;
  timestamp: number;
}

export interface RollbackResult {
  restoredTo: string;
  timestamp: number;
  summary: string;
}

/**
 * Abstracted git operations — allows mocking for tests.
 * In production, backed by isomorphic-git + node:fs.
 */
export interface GitIO {
  init(dir: string): Promise<void>;
  add(dir: string, filepath: string): Promise<void>;
  commit(dir: string, message: string, author: { name: string; email: string }): Promise<string>;
  log(dir: string, depth?: number): Promise<Array<{ oid: string; commit: { message: string; author: { timestamp: number } } }>>;
  checkout(dir: string, oid: string): Promise<void>;
  statusMatrix(dir: string): Promise<Array<[string, number, number, number]>>;
  listFiles(dir: string): Promise<string[]>;
}

const AUTHOR = { name: "tui-rpg", email: "tui-rpg@local" };

/**
 * Campaign repository — manages git snapshots for a campaign directory.
 */
export class CampaignRepo {
  private dir: string;
  private git: GitIO;
  private enabled: boolean;
  private exchangeCount = 0;
  private autoCommitInterval: number;
  private maxCommits: number;

  constructor(params: {
    dir: string;
    git: GitIO;
    enabled?: boolean;
    autoCommitInterval?: number;
    maxCommits?: number;
  }) {
    this.dir = params.dir;
    this.git = params.git;
    this.enabled = params.enabled ?? true;
    this.autoCommitInterval = params.autoCommitInterval ?? 3;
    this.maxCommits = params.maxCommits ?? 500;
  }

  /** Initialize git repo in campaign directory. No-op if already initialized. */
  async init(): Promise<void> {
    if (!this.enabled) return;
    await this.git.init(this.dir);
    // Initial commit with all existing files
    await this.stageAll();
    await this.commitIfDirty("auto: initial state");
  }

  /**
   * Track an exchange. Triggers auto-commit when interval is reached.
   * Returns the commit oid if a commit was made, null otherwise.
   */
  async trackExchange(): Promise<string | null> {
    if (!this.enabled) return null;
    this.exchangeCount++;
    if (this.exchangeCount >= this.autoCommitInterval) {
      this.exchangeCount = 0;
      return this.autoCommit(`auto: exchanges`);
    }
    return null;
  }

  /** Auto-commit with a standard message. */
  async autoCommit(message: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.stageAll();
    return this.commitIfDirty(message);
  }

  /** Scene transition commit. */
  async sceneCommit(sceneTitle: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.stageAll();
    return this.commitIfDirty(`scene: ${sceneTitle}`);
  }

  /** Session end commit. */
  async sessionCommit(sessionNum: number): Promise<string | null> {
    if (!this.enabled) return null;
    await this.stageAll();
    return this.commitIfDirty(`session: end session ${sessionNum}`);
  }

  /** Pre-destructive operation checkpoint. */
  async checkpoint(label: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.stageAll();
    return this.commitIfDirty(`checkpoint: before ${label}`);
  }

  /** Character change commit. */
  async characterCommit(characterName: string, change: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.stageAll();
    return this.commitIfDirty(`character: ${characterName} ${change}`);
  }

  /** Get commit log with parsed types. */
  async getLog(depth = 50): Promise<CommitInfo[]> {
    if (!this.enabled) return [];
    const entries = await this.git.log(this.dir, depth);
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message,
      type: parseCommitType(e.commit.message),
      timestamp: e.commit.author.timestamp,
    }));
  }

  /**
   * Rollback to a specific commit.
   * Supports: commit hash, "last", "scene:Title", "exchanges_ago:N"
   */
  async rollback(target: string): Promise<RollbackResult> {
    if (!this.enabled) throw new Error("Git is disabled.");

    // Safety checkpoint before rollback
    await this.stageAll();
    await this.commitIfDirty("checkpoint: before rollback");

    const log = await this.getLog(this.maxCommits);
    const targetCommit = resolveTarget(log, target);

    if (!targetCommit) {
      throw new Error(`Rollback target not found: ${target}`);
    }

    await this.git.checkout(this.dir, targetCommit.oid);

    return {
      restoredTo: targetCommit.oid,
      timestamp: targetCommit.timestamp,
      summary: targetCommit.message,
    };
  }

  /**
   * Prune old auto-commits beyond maxCommits.
   * Preserves scene, session, checkpoint, and character commits.
   */
  async pruneIfNeeded(): Promise<number> {
    if (!this.enabled) return 0;
    const log = await this.getLog(this.maxCommits + 100);
    if (log.length <= this.maxCommits) return 0;

    // We can't actually delete git history without rewriting it.
    // For now, just report how many would be pruned.
    // In practice, git's pack files handle deduplication well enough
    // that 500 commits of markdown/JSON is negligible.
    const excess = log.length - this.maxCommits;
    return excess;
  }

  /** Check if git is enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  // --- Internal ---

  private async stageAll(): Promise<void> {
    const matrix = await this.git.statusMatrix(this.dir);
    for (const [filepath, head, workdir, stage] of matrix) {
      // Stage any file that differs between workdir and staging
      if (workdir !== stage || head !== workdir) {
        await this.git.add(this.dir, filepath);
      }
    }
  }

  private async commitIfDirty(message: string): Promise<string | null> {
    const matrix = await this.git.statusMatrix(this.dir);
    const hasStagedChanges = matrix.some(
      ([, head, , stage]) => head !== stage,
    );
    if (!hasStagedChanges) return null;
    return this.git.commit(this.dir, message, AUTHOR);
  }
}

// --- Helpers ---

function parseCommitType(message: string): CommitType {
  if (message.startsWith("scene:")) return "scene";
  if (message.startsWith("session:")) return "session";
  if (message.startsWith("checkpoint:")) return "checkpoint";
  if (message.startsWith("character:")) return "character";
  return "auto";
}

function resolveTarget(log: CommitInfo[], target: string): CommitInfo | null {
  if (target === "last") {
    return log[0] ?? null;
  }

  // "exchanges_ago:N" — find the Nth auto commit
  if (target.startsWith("exchanges_ago:")) {
    const n = parseInt(target.split(":")[1], 10);
    let count = 0;
    for (const entry of log) {
      if (entry.type === "auto") {
        count++;
        if (count >= n) return entry;
      }
    }
    return null;
  }

  // "scene:Title" — find the first scene commit matching the title
  if (target.startsWith("scene:")) {
    const title = target.slice(6).toLowerCase();
    return log.find((e) => e.type === "scene" && e.message.toLowerCase().includes(title)) ?? null;
  }

  // "session:N"
  if (target.startsWith("session:")) {
    const num = target.slice(8);
    return log.find((e) => e.type === "session" && e.message.includes(num)) ?? null;
  }

  // Treat as commit hash
  return log.find((e) => e.oid.startsWith(target)) ?? null;
}
