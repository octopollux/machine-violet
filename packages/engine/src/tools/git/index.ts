export { CampaignRepo, queryCommitLog, performRollback, pruneEmptyDirs } from "./campaign-repo.js";
export type { CommitInfo, CommitType, GitIO, RollbackResult } from "./campaign-repo.js";
export { createGitIO } from "./isogit-adapter.js";
