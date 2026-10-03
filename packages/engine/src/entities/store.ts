/** Specialized entity presentation over the campaign's generic SQLite tree. */
import { getCampaignKnowledge, type CampaignKnowledgeStore, type KnowledgeFileIO } from "../knowledge/store.js";
import { serializeEntity } from "../tools/filesystem/frontmatter.js";
import { formatChangelogEntry } from "../tools/filesystem/changelog.js";
import { getEntitySchema, isFileBackedEntityType, type FileBackedEntityType } from "@machine-violet/shared/schemas/entities/index.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import type { KnowledgeNode, KnowledgeValue } from "@machine-violet/shared/types/knowledge.js";
export interface EntityFileIO extends KnowledgeFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  deleteFile?(path: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
}
export interface ValidationIssue {
  level: "warning" | "error";
  field?: string;
  msg: string;
}
export interface EntityRecord {
  type: FileBackedEntityType;
  id: string;
  displayName: string;
  aliases: string[];
  raw: string;
  body: string;
  frontMatter: Record<string, unknown>;
  changelog: string[];
  schema: {
    version: string;
    knownFields: string[];
    required: string[];
    source: string;
  };
  validation: {
    status: "ok" | "warnings" | "errors";
    issues: ValidationIssue[];
  };
  references: {
    outbound: string[];
    inbound: string[];
    dead: string[];
  };
  drift: {
    unknownFields: string[];
    missingFields: string[];
  };
}
export interface ListEntry {
  id: string;
  displayName: string;
  aliases: string[];
  path: string;
}
export interface EntityPatch {
  displayName?: string;
  frontMatter?: Record<string, unknown>;
  body?: string;
  changelogEntry?: string;
}
export interface DeleteResult {
  type: FileBackedEntityType;
  id: string;
  path: string;
  deadReferences: {
    file: string;
    line: number;
    display: string;
  }[];
}
export interface ObservedField {
  occursIn: number;
  examples: string[];
}
export type ObservedFields = Record<string, ObservedField>;
export function resolveEntityTypeField(category: FileBackedEntityType, incoming: unknown): string {
  if (category !== "character" || typeof incoming !== "string" || !incoming.trim())
    return category;
  return isFileBackedEntityType(incoming.toLowerCase()) ? category : incoming.trim();
}
const COLLECTIONS: Record<string, string> = { character: "Characters", location: "Locations", faction: "Factions", item: "Items", lore: "Lore" };
export class EntityStore {
  constructor(public readonly campaignRoot: string, private readonly fileIO: EntityFileIO) { }
  knowledge(): Promise<CampaignKnowledgeStore> { return getCampaignKnowledge(this.campaignRoot, this.fileIO); }
  /** These are virtual handles, never filesystem paths. */
  pathFor(type: string, id: string): {
    abs: string;
    rel: string;
  } { const rel = `knowledge:${type}/${id}`; return { abs: rel, rel }; }
  dirFor(type: string): string { return `knowledge:${COLLECTIONS[type] ?? type}`; }
  async exists(_type: string, id: string): Promise<boolean> { return (await (await this.knowledge()).resolve(id)) !== null; }
  private async category(uid: string): Promise<string> {
    const outline = await (await this.knowledge()).outline();
    let row = outline.find(r => r.uid === uid);
    while (row?.parent && row.parent !== "root")
      row = outline.find(r => r.uid === row?.parent);
    return Object.entries(COLLECTIONS).find(([, name]) => name === row?.name)?.[0] ?? row?.name ?? "lore";
  }
  async scanIndex(): Promise<EntityTree> {
    const store = await this.knowledge();
    const tree: EntityTree = {};
    for (const entry of await store.outline()) {
      if (entry.kind !== "entity")
        continue;
      const node = await store.read(entry.uid, { textLimit: 0, logLimit: 0 });
      tree[node.uid] = { name: node.name, aliases: node.aliases, type: await this.category(node.uid), path: `knowledge:${node.uid}` };
    }
    return tree;
  }
  async list(type: string): Promise<ListEntry[]> {
    const tree = await this.scanIndex();
    return Object.entries(tree).filter(([, e]) => e.type.toLowerCase() === type.toLowerCase()).map(([id, e]) => ({ id, displayName: e.name, aliases: e.aliases, path: e.path }));
  }
  private async present(type: FileBackedEntityType, node: KnowledgeNode): Promise<EntityRecord> {
    const schema = getEntitySchema(type);
    const tree = await this.scanIndex();
    const frontMatter: Record<string, unknown> = { ...node.fields, additional_names: node.aliases.filter(a => a !== node.name).join(", ") };
    const changelog = node.logs.map(l => formatChangelogEntry(Number(l.metadata.scene ?? 0), l.body));
    const store = await this.knowledge();
    const inbound: string[] = [];
    for (const uid of Object.keys(tree))
      if (uid !== node.uid && (await store.read(uid, { textLimit: 0, logLimit: 0 })).references.some(r => r.target === node.uid))
        inbound.push(uid);
    return { type, id: node.uid, displayName: node.name, aliases: node.aliases, body: node.body, frontMatter, changelog,
      raw: serializeEntity(node.name, frontMatter, node.body, changelog),
      schema: { version: "sqlite-1", knownFields: Object.keys(schema.fields), required: [], source: `knowledge:${node.uid}` },
      validation: { status: "ok", issues: [] }, references: { outbound: node.references.map(r => r.target), inbound, dead: [] }, drift: { unknownFields: [], missingFields: [] } };
  }
  async read(type: FileBackedEntityType, id: string): Promise<EntityRecord> {
    const store = await this.knowledge();
    const uid = await store.resolve(id);
    if (!uid)
      throw new EntityNotFoundError(type, id);
    return this.present(type, await store.read(uid, { textLimit: 100000, logLimit: 1000 }));
  }
  async create(type: FileBackedEntityType, patch: EntityPatch, sceneNumber = 0): Promise<EntityRecord> {
    if (!patch.displayName?.trim())
      throw new EntityValidationError("create requires a displayName");
    const store = await this.knowledge();
    const fields = { ...patch.frontMatter, type: resolveEntityTypeField(type, patch.frontMatter?.type) } as Record<string, KnowledgeValue>;
    const aliases = typeof fields.additional_names === "string" ? fields.additional_names.split(",").map(s => s.trim()).filter(Boolean) : undefined;
    const result = await store.mutate([{ op: "upsert", collection: COLLECTIONS[type], name: patch.displayName, aliases, fields, body: patch.body, history: patch.changelogEntry }], { sceneNumber, source: "entity" });
    return this.read(type, result.identities[0].uid);
  }
  async update(type: FileBackedEntityType, id: string, patch: EntityPatch, sceneNumber = 0): Promise<EntityRecord> {
    const store = await this.knowledge();
    const uid = await store.resolve(id);
    if (!uid)
      throw new EntityNotFoundError(type, id);
    const allFields = { ...patch.frontMatter } as Record<string, KnowledgeValue>;
    const keys = Object.keys(allFields).filter(k => allFields[k] === null);
    const fields = Object.fromEntries(Object.entries(allFields).filter(([, value]) => value !== null));
    const aliases = typeof fields.additional_names === "string" ? fields.additional_names.split(",").map(s => s.trim()).filter(Boolean) : undefined;
    await store.mutate([{ op: "patch", uid, name: patch.displayName, fields, body: patch.body, aliases, history: patch.changelogEntry }, ...(keys.length ? [{ op: "remove_fields" as const, uid, keys }] : [])], { sceneNumber, source: "entity" });
    return this.read(type, uid);
  }
  async delete(type: FileBackedEntityType, id: string): Promise<DeleteResult> {
    const store = await this.knowledge();
    const uid = await store.resolve(id);
    if (!uid)
      throw new EntityNotFoundError(type, id);
    await store.mutate([{ op: "delete", uid }], { source: "entity" });
    return { type, id: uid, path: `knowledge:${uid}`, deadReferences: [] };
  }
  async scanObservedFields(type: FileBackedEntityType): Promise<ObservedFields> {
    const fields: ObservedFields = {};
    for (const item of await this.list(type))
      for (const key of Object.keys((await this.read(type, item.id)).frontMatter)) {
        const field = fields[key] ?? (fields[key] = { occursIn: 0, examples: [] });
        field.occursIn++;
        if (field.examples.length < 5)
          field.examples.push(item.id);
      }
    return fields;
  }
  async scanAllObservedFields(): Promise<Record<FileBackedEntityType, ObservedFields>> {
    return Object.fromEntries(await Promise.all(Object.keys(COLLECTIONS).map(async (type) => [type, await this.scanObservedFields(type as FileBackedEntityType)]))) as Record<FileBackedEntityType, ObservedFields>;
  }
  async detectOrphans(): Promise<{
    type: FileBackedEntityType;
    id: string;
    path: string;
  }[]> {
    const out: {
      type: FileBackedEntityType;
      id: string;
      path: string;
    }[] = [];
    for (const [id, entry] of Object.entries(await this.scanIndex()))
      if ((await this.read((isFileBackedEntityType(entry.type) ? entry.type : "lore"), id)).references.inbound.length === 0)
        out.push({ type: entry.type as FileBackedEntityType, id, path: entry.path });
    return out;
  }
}
export class EntityNotFoundError extends Error {
  constructor(public type: string, public id: string) { super(`Entity not found: ${type}/${id}`); this.name = "EntityNotFoundError"; }
}
export class EntityValidationError extends Error {
  constructor(message: string) { super(message); this.name = "EntityValidationError"; }
}
