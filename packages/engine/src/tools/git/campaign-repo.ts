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
  remove(dir: string, filepath: string): Promise<void>;
  commit(dir: string, message: string, author: { name: string; email: string }): Promise<string>;
  log(dir: string, depth?: number): Promise<{ oid: string; commit: { message: string; author: { timestamp: number } } }[]>;
  checkout(dir: string, oid: string): Promise<void>;
  /** Hard-reset: move branch ref to oid and update working tree. History after oid becomes dangling. */
  resetTo(dir: string, oid: string): Promise<void>;
  /** Delete loose objects not reachable from HEAD. Returns number of objects pruned. */
  pruneUnreachable(dir: string): Promise<number>;
  statusMatrix(dir: string): Promise<[string, number, number, number][]>;
  listFiles(dir: string): Promise<string[]>;
}

const AUTHOR = { name: "machine-violet", email: "machine-violet@local" };

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
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Optional hook called before every commit to flush pending I/O.
   * The engine sets this to flush the StatePersister so that
   * state/conversation.json, state/scene.json, etc. are on disk
   * before stageAll() reads the filesystem.
   */
  preCommitHook: (() => Promise<void>) | null = null;

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
    this.initialized = true;
  }

  /** Ensure init() has been called. Safe to call multiple times. */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.init().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  /**
   * Track an exchange. Triggers auto-commit when interval is reached.
   * Returns the commit oid if a commit was made, null otherwise.
   */
  async trackExchange(): Promise<string | null> {
    if (!this.enabled) return null;
    await this.ensureInit();
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
    await this.ensureInit();
    await this.stageAll();
    return this.commitIfDirty(message);
  }

  /** Scene transition commit. */
  async sceneCommit(sceneTitle: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.ensureInit();
    await this.stageAll();
    return this.commitIfDirty(`scene: ${sceneTitle}`);
  }

  /** Session end commit. */
  async sessionCommit(sessionNum: number): Promise<string | null> {
    if (!this.enabled) return null;
    await this.ensureInit();
    await this.stageAll();
    return this.commitIfDirty(`session: end session ${sessionNum}`);
  }

  /** Pre-destructive operation checkpoint. */
  async checkpoint(label: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.ensureInit();
    await this.stageAll();
    return this.commitIfDirty(`checkpoint: before ${label}`);
  }

  /** Character change commit. */
  async characterCommit(characterName: string, change: string): Promise<string | null> {
    if (!this.enabled) return null;
    await this.ensureInit();
    await this.stageAll();
    return this.commitIfDirty(`character: ${characterName} ${change}`);
  }

  /** Get commit log with parsed types. */
  async getLog(depth = 50): Promise<CommitInfo[]> {
    if (!this.enabled) return [];
    await this.ensureInit();
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
    await this.ensureInit();

    // Resolve target BEFORE the safety checkpoint so "last" etc.
    // refer to the pre-rollback history, not the checkpoint itself.
    const log = await this.getLog(this.maxCommits);
    const targetCommit = resolveTarget(log, target);

    if (!targetCommit) {
      throw new Error(`Rollback target not found: ${target}`);
    }

    // Safety checkpoint — preserves current state for recovery.
    // Note: this checkpoint becomes dangling after the reset and will be pruned.
    await this.stageAll();
    await this.commitIfDirty("checkpoint: before rollback");

    // Hard-reset: move branch to target, making everything after it dangling
    await this.git.resetTo(this.dir, targetCommit.oid);

    // Clean up dangling objects (old commits, trees, blobs)
    await this.git.pruneUnreachable(this.dir);

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
    await this.ensureInit();
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
    // Flush any pending I/O so state files are on disk before we read the filesystem
    await this.preCommitHook?.();
    const matrix = await this.git.statusMatrix(this.dir);
    for (const [filepath, head, workdir, stage] of matrix) {
      // Skip .debug/ — context dumps are diagnostic and may be locked
      if (filepath.startsWith(".debug/") || filepath.startsWith(".debug\\")) continue;
      if (workdir === 0 && head !== 0) {
        // File deleted from workdir — stage the removal
        await this.git.remove(this.dir, filepath);
      } else if (workdir !== stage || head !== workdir) {
        // File added or modified — stage it
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

/**
 * Query the commit log with optional filtering — shared helper for agent tools.
 * Returns a terse formatted string suitable for tool results.
 */
export async function queryCommitLog(
  repo: CampaignRepo,
  options: { depth?: number; type?: string; search?: string },
): Promise<string> {
  if (!repo.isEnabled()) return "Git is disabled for this campaign.";

  const depth = Math.min(Math.max(options.depth ?? 20, 1), 100);
  const log = await repo.getLog(depth);

  let filtered = log;
  if (options.type) {
    const t = options.type as CommitType;
    filtered = filtered.filter((c) => c.type === t);
  }
  if (options.search) {
    const term = options.search.toLowerCase();
    filtered = filtered.filter((c) => c.message.toLowerCase().includes(term));
  }

  if (filtered.length === 0) return "No matching commits found.";

  const lines = filtered.map((c) => {
    const short = c.oid.slice(0, 7);
    const date = formatLocalTime(c.timestamp);
    return `${short} [${c.type}] ${c.message} (${date})`;
  });

  const header = filtered.length < log.length
    ? `${filtered.length} of ${log.length} commits (filtered):`
    : `${log.length} commits:`;
  return header + "\n" + lines.join("\n");
}

/** Format epoch seconds as local time: "YYYY-MM-DD HH:MM" */
function formatLocalTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- FileIO subset needed for pruneEmptyDirs ---

interface PruneFileIO {
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  rmdir?(path: string): Promise<void>;
}

/**
 * Canonical rollback: git restore + ghost-dir cleanup.
 * All callsites must use this — callers handle process.exit themselves.
 */
export async function performRollback(
  repo: CampaignRepo,
  target: string,
  campaignRoot: string,
  fileIO: PruneFileIO,
): Promise<RollbackResult> {
  const result = await repo.rollback(target);
  await pruneEmptyDirs(campaignRoot, fileIO);
  return result;
}

/**
 * Recursively remove empty directories under known campaign subdirectories.
 * isomorphic-git's checkout removes files but leaves empty parent directories
 * behind, which confuses scene detection.
 *
 * Safety: only walks known campaign subdirectories (characters, locations, etc.)
 * and requires config.json to exist at root — won't accidentally nuke anything
 * if called with a wrong path.
 */
export async function pruneEmptyDirs(root: string, io: PruneFileIO): Promise<number> {
  // Normalize to forward slashes
  const norm = (p: string) => p.replace(/\\/g, "/");

  // Safety: verify this looks like a campaign root
  const configPath = norm(root) + "/config.json";
  if (!(await io.exists(configPath))) return 0;

  let removed = 0;
  const normalizedRoot = norm(root);

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await io.listDir(dir);
    } catch {
      return;
    }
    // Recurse into subdirectories first (depth-first)
    for (const entry of entries) {
      const child = norm(dir) + "/" + entry;
      // Skip dotfiles/dirs (e.g. .git)
      if (entry.startsWith(".")) continue;
      // Heuristic: entries without a dot extension are likely directories
      if (!entry.includes(".")) {
        await walk(child);
      }
    }
    // Re-read after pruning children
    try {
      entries = await io.listDir(dir);
    } catch {
      return;
    }
    // Don't prune the root or top-level subdirs themselves
    if (entries.length === 0 && norm(dir) !== normalizedRoot) {
      try {
        await io.rmdir?.(dir);
        removed++;
      } catch {
        // Directory not empty or permission error — skip
      }
    }
  }

  // Only walk known campaign subdirectories — never arbitrary paths
  const campaignSubdirs = [
    "campaign/scenes", "campaign/session-recaps",
    "characters", "locations", "factions", "lore", "items", "players",
  ];
  for (const sub of campaignSubdirs) {
    const subPath = normalizedRoot + "/" + sub;
    if (await io.exists(subPath)) {
      await walk(subPath);
    }
  }
  return removed;
}

function resolveTarget(log: CommitInfo[], target: string): CommitInfo | null {
  if (target === "last") {
    return log[0] ?? null;
  }

  // "exchanges_ago:N" — undo N exchanges (skip the most recent auto commit,
  // which represents the current state, then count N auto commits back)
  if (target.startsWith("exchanges_ago:")) {
    const n = parseInt(target.split(":")[1], 10);
    let count = 0;
    for (const entry of log) {
      if (entry.type === "auto") {
        count++;
        if (count > n) return entry;
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
