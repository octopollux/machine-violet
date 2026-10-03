import type { KnowledgeMutationOptions, KnowledgeMutationResult, KnowledgeNode, KnowledgeNotice, KnowledgeOperation, KnowledgeOutlineEntry, KnowledgeReadOptions } from "@machine-violet/shared/types/knowledge.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
export const KNOWLEDGE_FILE = "knowledge.sqlite";
export interface CampaignKnowledgeStore {
  outline(): Promise<KnowledgeOutlineEntry[]>;
  snapshot(): Promise<string>;
  resolve(handle: string): Promise<string | null>;
  /** Resolve an exact current or historical UID; never consult names or aliases. */
  resolveUid(handle: string): Promise<string | null>;
  read(handle: string, options?: KnowledgeReadOptions): Promise<KnowledgeNode>;
  mutate(operations: KnowledgeOperation[], options?: KnowledgeMutationOptions): Promise<KnowledgeMutationResult>;
  pendingNotices(): Promise<KnowledgeNotice[]>;
  acknowledgeNotices(ids: number[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Permanent owning-session teardown; unlike close(), later access is rejected. */
  dispose?(): Promise<void>;
  withSnapshot<T>(capture: () => Promise<T>): Promise<T>;
}
export interface KnowledgeFileIO {
  campaignKnowledge?: (root: string, options?: {
    create?: boolean;
  }) => Promise<CampaignKnowledgeStore>;
}
/** Test I/O can supply a provider; otherwise attach one owned by this I/O instance. */
export async function getCampaignKnowledge(root: string, io: KnowledgeFileIO, options?: {
  create?: boolean;
}): Promise<CampaignKnowledgeStore> {
  if (!io.campaignKnowledge) {
    if (process.env.NODE_ENV !== "test")
      throw new Error("Campaign I/O is missing its injected knowledge-store provider");
    const stores = new Map<string, CampaignKnowledgeStore>();
    io.campaignKnowledge = async (campaignRoot) => {
      let store = stores.get(campaignRoot);
      if (!store) {
        store = new SqliteKnowledgeStore(":memory:");
        stores.set(campaignRoot, store);
      }
      return store;
    };
  }
  return io.campaignKnowledge(root, options);
}
