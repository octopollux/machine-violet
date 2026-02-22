import { describe, it, expect, vi } from "vitest";
import { CampaignRepo } from "./campaign-repo.js";
import type { GitIO } from "./campaign-repo.js";

// --- Mock GitIO ---

function mockGitIO(): GitIO & {
  commits: Array<{ message: string; oid: string; timestamp: number }>;
  staged: Set<string>;
  initCalled: boolean;
} {
  const commits: Array<{ message: string; oid: string; timestamp: number }> = [];
  const staged = new Set<string>();
  let oidCounter = 0;

  const io: ReturnType<typeof mockGitIO> = {
    commits,
    staged,
    initCalled: false,

    init: vi.fn(async () => { io.initCalled = true; }),

    add: vi.fn(async (_dir, filepath) => {
      staged.add(filepath);
    }),

    commit: vi.fn(async (_dir, message) => {
      const oid = `commit_${++oidCounter}`;
      const timestamp = Math.floor(Date.now() / 1000) + oidCounter;
      commits.unshift({ message, oid, timestamp }); // Most recent first
      staged.clear();
      return oid;
    }),

    log: vi.fn(async (_dir, depth = 50) => {
      return commits.slice(0, depth).map((c) => ({
        oid: c.oid,
        commit: {
          message: c.message,
          author: { timestamp: c.timestamp },
        },
      }));
    }),

    checkout: vi.fn(async () => {}),

    // Tracks staging: after add() puts a file in `staged`, statusMatrix
    // returns it as staged (head=1, workdir=2, stage=2 → head !== stage).
    // Before add, returns unstaged (head=1, workdir=2, stage=1).
    statusMatrix: vi.fn(async () => {
      if (staged.size > 0) {
        return [...staged].map((f) => [f, 1, 2, 2] as [string, number, number, number]);
      }
      return [["config.json", 1, 2, 1] as [string, number, number, number]];
    }),

    listFiles: vi.fn(async () => ["config.json"]),
  };

  return io;
}

// --- Tests ---

describe("CampaignRepo", () => {
  it("initializes git repo and creates initial commit", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    await repo.init();

    expect(git.initCalled).toBe(true);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0].message).toBe("auto: initial state");
  });

  it("tracks exchanges and auto-commits at interval", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git, autoCommitInterval: 3 });

    // First two exchanges don't trigger a commit
    expect(await repo.trackExchange()).toBeNull();
    expect(await repo.trackExchange()).toBeNull();

    // Third exchange triggers auto-commit
    const oid = await repo.trackExchange();
    expect(oid).toBeTruthy();
    expect(git.commits[0].message).toBe("auto: exchanges");
  });

  it("creates scene commits", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    const oid = await repo.sceneCommit("The Goblin Caves");
    expect(oid).toBeTruthy();
    expect(git.commits[0].message).toBe("scene: The Goblin Caves");
  });

  it("creates session commits", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    const oid = await repo.sessionCommit(3);
    expect(oid).toBeTruthy();
    expect(git.commits[0].message).toBe("session: end session 3");
  });

  it("creates checkpoint commits", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    const oid = await repo.checkpoint("scene_transition");
    expect(oid).toBeTruthy();
    expect(git.commits[0].message).toBe("checkpoint: before scene_transition");
  });

  it("creates character commits", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    const oid = await repo.characterCommit("Aldric", "level 5");
    expect(oid).toBeTruthy();
    expect(git.commits[0].message).toBe("character: Aldric level 5");
  });

  it("skips commits when nothing is dirty", async () => {
    const git = mockGitIO();
    // Override statusMatrix to return clean state
    git.statusMatrix = vi.fn(async () => [
      ["config.json", 1, 1, 1] as [string, number, number, number], // unchanged
    ]);

    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    const oid = await repo.sceneCommit("Clean State");
    expect(oid).toBeNull();
  });

  it("does nothing when disabled", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git, enabled: false });

    await repo.init();
    expect(git.initCalled).toBe(false);

    const oid = await repo.trackExchange();
    expect(oid).toBeNull();

    expect(repo.isEnabled()).toBe(false);
  });

  it("gets log with parsed commit types", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    await repo.autoCommit("auto: exchanges");
    await repo.sceneCommit("The Throne Room");
    await repo.sessionCommit(1);
    await repo.checkpoint("rollback");
    await repo.characterCommit("Aldric", "level 3");

    const log = await repo.getLog();
    expect(log).toHaveLength(6); // 5 explicit + 1 auto-init
    expect(log[0].type).toBe("character");
    expect(log[1].type).toBe("checkpoint");
    expect(log[2].type).toBe("session");
    expect(log[3].type).toBe("scene");
    expect(log[4].type).toBe("auto");
    expect(log[5].type).toBe("auto"); // auto: initial state
  });
});

describe("CampaignRepo rollback", () => {
  async function setupWithHistory() {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });

    await repo.autoCommit("auto: exchanges 1-3");
    await repo.sceneCommit("The Goblin Caves");
    await repo.autoCommit("auto: exchanges 4-6");
    await repo.sessionCommit(1);

    return { git, repo };
  }

  it("rolls back to 'last' commit", async () => {
    const { git, repo } = await setupWithHistory();

    const result = await repo.rollback("last");
    // "last" returns the most recent commit (which is the checkpoint created before rollback)
    // After the checkpoint, the log has 5 entries (4 original + 1 checkpoint)
    expect(result.restoredTo).toBeTruthy();
    expect(git.checkout).toHaveBeenCalled();
  });

  it("rolls back to a scene commit", async () => {
    const { git, repo } = await setupWithHistory();

    const result = await repo.rollback("scene:goblin");
    expect(result.summary).toContain("Goblin Caves");
    expect(git.checkout).toHaveBeenCalled();
  });

  it("rolls back to a session commit", async () => {
    const { repo } = await setupWithHistory();

    const result = await repo.rollback("session:1");
    expect(result.summary).toContain("session 1");
  });

  it("rolls back by exchanges_ago", async () => {
    const { repo } = await setupWithHistory();

    const result = await repo.rollback("exchanges_ago:1");
    expect(result.summary).toContain("auto:");
  });

  it("throws on unknown target", async () => {
    const { repo } = await setupWithHistory();

    await expect(repo.rollback("nonexistent")).rejects.toThrow("not found");
  });

  it("throws when disabled", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git, enabled: false });

    await expect(repo.rollback("last")).rejects.toThrow("disabled");
  });

  it("creates a safety checkpoint before rollback", async () => {
    const { git, repo } = await setupWithHistory();

    await repo.rollback("last");

    // Should have created a checkpoint commit before the rollback
    const checkpointExists = git.commits.some((c) => c.message.includes("before rollback"));
    expect(checkpointExists).toBe(true);
  });
});
