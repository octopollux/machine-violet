import { describe, it, expect, vi } from "vitest";
import { CampaignRepo, queryCommitLog } from "./campaign-repo.js";
import type { GitIO } from "./campaign-repo.js";

// --- Mock GitIO ---

// Fixed base: 2025-03-15T12:00:00Z — each commit offsets by 1 day backward
const MOCK_BASE_TS = Math.floor(new Date("2025-03-15T12:00:00Z").getTime() / 1000);
const ONE_DAY = 86400;

function mockGitIO(): GitIO & {
  commits: { message: string; oid: string; timestamp: number }[];
  staged: Set<string>;
  removed: Set<string>;
  initCalled: boolean;
  pruned: number;
} {
  const commits: { message: string; oid: string; timestamp: number }[] = [];
  const staged = new Set<string>();
  const removed = new Set<string>();
  let oidCounter = 0;

  const io: ReturnType<typeof mockGitIO> = {
    commits,
    staged,
    removed,
    initCalled: false,
    pruned: 0,

    init: vi.fn(async () => { io.initCalled = true; }),

    add: vi.fn(async (_dir, filepath) => {
      staged.add(filepath);
    }),

    remove: vi.fn(async (_dir, filepath) => {
      removed.add(filepath);
    }),

    commit: vi.fn(async (_dir, message) => {
      const oid = `commit_${++oidCounter}`;
      // Each commit is 1 day after the previous, so dates are distinguishable
      const timestamp = MOCK_BASE_TS + oidCounter * ONE_DAY;
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

    resetTo: vi.fn(async (_dir, oid) => {
      // Simulate hard reset: truncate commits to the target and everything before it
      const idx = commits.findIndex((c) => c.oid === oid);
      if (idx >= 0) {
        commits.splice(0, idx); // Remove everything newer than target
      }
    }),

    pruneUnreachable: vi.fn(async () => {
      io.pruned++;
      return 0;
    }),

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

  it("stages deleted files with remove instead of add", async () => {
    const git = mockGitIO();
    // statusMatrix: alice-wunderlich.md deleted (head=1, workdir=0, stage=1)
    //               alice.md modified (head=1, workdir=2, stage=1)
    git.statusMatrix = vi.fn(async () => [
      ["characters/alice-wunderlich.md", 1, 0, 1] as [string, number, number, number],
      ["characters/alice.md", 1, 2, 1] as [string, number, number, number],
    ]);

    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.autoCommit("auto: after merge");

    expect(git.remove).toHaveBeenCalledWith("/tmp/campaign", "characters/alice-wunderlich.md");
    expect(git.add).toHaveBeenCalledWith("/tmp/campaign", "characters/alice.md");
    // Should NOT have tried to add the deleted file
    expect(git.add).not.toHaveBeenCalledWith("/tmp/campaign", "characters/alice-wunderlich.md");
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
    expect(result.restoredTo).toBeTruthy();
    expect(git.resetTo).toHaveBeenCalled();
    // Should NOT use plain checkout for rollback
    expect(git.checkout).not.toHaveBeenCalled();
  });

  it("rolls back to a scene commit", async () => {
    const { git, repo } = await setupWithHistory();

    const result = await repo.rollback("scene:goblin");
    expect(result.summary).toContain("Goblin Caves");
    expect(git.resetTo).toHaveBeenCalled();
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

  it("prunes dangling history after reset", async () => {
    const { git, repo } = await setupWithHistory();

    await repo.rollback("scene:goblin");

    expect(git.pruneUnreachable).toHaveBeenCalledWith("/tmp/campaign");
    expect(git.pruned).toBe(1);
  });

  it("produces linear history after rollback", async () => {
    const { git, repo } = await setupWithHistory();

    // History before: init, auto1, scene, auto2, session (5 commits)
    const logBefore = await repo.getLog();
    expect(logBefore).toHaveLength(5);

    // Roll back to scene commit
    await repo.rollback("scene:goblin");

    // After reset, commits newer than the scene should be gone
    // Mock's resetTo truncates: scene commit is now at index 0
    const logAfter = await repo.getLog();
    expect(logAfter.length).toBeLessThan(logBefore.length);
    expect(logAfter[0].message).toContain("Goblin Caves");
  });
});

describe("queryCommitLog", () => {
  async function repoWithHistory() {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.autoCommit("auto: exchanges 1-3");
    await repo.sceneCommit("The Goblin Caves");
    await repo.autoCommit("auto: exchanges 4-6");
    await repo.sessionCommit(1);
    await repo.characterCommit("Aldric", "level 3");
    return repo;
  }

  it("returns all commits with distinct dates", async () => {
    const repo = await repoWithHistory();
    const result = await queryCommitLog(repo, {});
    expect(result).toContain("commits:");
    expect(result).toContain("[scene]");
    expect(result).toContain("[session]");
    expect(result).toContain("[auto]");
    expect(result).toContain("[character]");
    expect(result).toContain("Goblin Caves");
    // Commits should show different dates (mock spaces them 1 day apart)
    // The initial auto-init is day 1 (2025-03-16), then each explicit commit adds a day
    expect(result).toContain("2025-03-");
    // Verify at least two different dates appear
    const dateMatches = result.match(/\((\d{4}-\d{2}-\d{2})/g) ?? [];
    const uniqueDates = new Set(dateMatches);
    expect(uniqueDates.size).toBeGreaterThan(1);
  });

  it("filters by type", async () => {
    const repo = await repoWithHistory();
    const result = await queryCommitLog(repo, { type: "scene" });
    expect(result).toContain("filtered");
    expect(result).toContain("[scene]");
    expect(result).not.toContain("[session]");
    expect(result).not.toContain("[character]");
  });

  it("filters by search term", async () => {
    const repo = await repoWithHistory();
    const result = await queryCommitLog(repo, { search: "goblin" });
    expect(result).toContain("Goblin Caves");
    expect(result).toContain("filtered");
  });

  it("returns no-match message when nothing found", async () => {
    const repo = await repoWithHistory();
    const result = await queryCommitLog(repo, { search: "zzzzz" });
    expect(result).toBe("No matching commits found.");
  });

  it("respects depth limit", async () => {
    const repo = await repoWithHistory();
    const result = await queryCommitLog(repo, { depth: 2 });
    // Only 2 commits fetched from log
    const lines = result.split("\n").filter((l) => l.match(/^\w{7} /));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("clamps depth to max 100", async () => {
    const repo = await repoWithHistory();
    // Should not throw with absurd depth
    const result = await queryCommitLog(repo, { depth: 9999 });
    expect(result).toContain("commits:");
  });

  it("reports disabled git", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git, enabled: false });
    const result = await queryCommitLog(repo, {});
    expect(result).toContain("disabled");
  });
});
