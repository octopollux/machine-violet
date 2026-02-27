/** File categories for the tree sidebar. */
export type FileCategory =
  | "state"
  | "entity"
  | "transcript"
  | "context-dump"
  | "thinking"
  | "map"
  | "config"
  | "other";

/** SSE event: a file was created, changed, or deleted. */
export interface FileChangeEvent {
  type: "file-change";
  campaignSlug: string;
  relativePath: string;
  category: FileCategory;
  changeType: "add" | "change" | "unlink";
}

/** SSE event: a campaign was added or removed. */
export interface CampaignChangeEvent {
  type: "campaign-change";
  campaignSlug: string;
  changeType: "add" | "remove";
}

export type SSEEvent = FileChangeEvent | CampaignChangeEvent;

/** API response: list of campaigns. */
export interface CampaignInfo {
  slug: string;
  name: string;
  path: string;
}

/** API response: file tree entry. */
export interface TreeEntry {
  relativePath: string;
  category: FileCategory;
  size: number;
  mtime: string;
}
