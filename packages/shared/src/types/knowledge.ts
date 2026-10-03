/** Campaign knowledge values. References are explicit, never inferred from prose. */
export type KnowledgeValue = null | boolean | number | string | KnowledgeValue[] | {
  [key: string]: KnowledgeValue;
};
export interface KnowledgeReference {
  source: string;
  target: string;
  label: string;
}
export interface KnowledgeLogEntry {
  id: number;
  body: string;
  metadata: Record<string, KnowledgeValue>;
  textLength?: number;
  textNextOffset?: number;
}
export interface KnowledgeNode {
  uid: string;
  parent: string | null;
  name: string;
  kind: "collection" | "entity" | "value";
  value?: KnowledgeValue;
  position: number;
  note: string;
  aliases: string[];
  fields: Record<string, KnowledgeValue>;
  body: string;
  visibility: "private" | "player-facing";
  references: KnowledgeReference[];
  logs: KnowledgeLogEntry[];
  textLength: number;
  logCount: number;
  children?: KnowledgeOutlineEntry[];
  childCount?: number;
  textNextOffset?: number;
  logNextOffset?: number;
}
export interface KnowledgeOutlineEntry {
  uid: string;
  parent: string | null;
  name: string;
  kind: KnowledgeNode["kind"];
  note: string;
  position: number;
}
export interface KnowledgeNotice {
  id: number;
  source: string;
  changed: string[];
  identities: {
    uid: string;
    name: string;
    aliases: string[];
  }[];
  candidates: string[];
}
export type KnowledgeOperation = {
  op: "create_collection";
  parent?: string;
  name: string;
  note?: string;
} | {
  op: "upsert";
  collection: string;
  name?: string;
  uid?: string;
  aliases?: string[];
  fields?: Record<string, KnowledgeValue>;
  body?: string;
  visibility?: KnowledgeNode["visibility"];
  history?: string;
} | {
  op: "patch";
  uid: string;
  name?: string;
  aliases?: string[];
  fields?: Record<string, KnowledgeValue>;
  body?: string;
  visibility?: KnowledgeNode["visibility"];
  history?: string;
} | {
  /** Publish only explicitly supplied player-safe facts about an existing identity. */
  op: "disclose";
  uid: string;
  name: string;
  summary: string;
  aliases?: string[];
} | {
  op: "remove_fields";
  uid: string;
  keys: string[];
} | {
  op: "move";
  uid: string;
  parent: string;
  index?: number;
} | {
  op: "consolidate";
  uid: string;
  target: string;
} | {
  op: "delete";
  uid: string;
} | {
  op: "append_log";
  uid: string;
  body: string;
  metadata?: Record<string, KnowledgeValue>;
} | {
  op: "append_text";
  uid: string;
  text: string;
} | {
  op: "create_node";
  parent: string;
  name?: string;
  value: KnowledgeValue;
  index?: number;
} | {
  op: "set_value";
  uid: string;
  value: KnowledgeValue;
} | {
  op: "add_reference" | "remove_reference";
  source: string;
  target: string;
  label?: string;
};
export interface KnowledgeMutationResult {
  identities: {
    uid: string;
    name: string;
    aliases: string[];
  }[];
  changed: string[];
  candidates: string[];
  noticeId?: number;
}
export interface KnowledgeReadOptions {
  textOffset?: number;
  textLimit?: number;
  logOffset?: number;
  logLimit?: number;
  childOffset?: number;
  childLimit?: number;
  logEntryId?: number;
  logTextOffset?: number;
  logTextLimit?: number;
}
export interface KnowledgeMutationOptions {
  operationId?: string;
  sceneNumber?: number;
  source?: string;
}
