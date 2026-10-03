import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { CampaignKnowledgeStore } from "./store.js";
import type { KnowledgeLogEntry, KnowledgeMutationOptions, KnowledgeMutationResult, KnowledgeNode, KnowledgeNotice, KnowledgeOperation, KnowledgeOutlineEntry, KnowledgeReadOptions, KnowledgeReference, KnowledgeValue } from "@machine-violet/shared/types/knowledge.js";
interface Row {
  uid: string;
  parent: string | null;
  slot: string;
  name: string;
  kind: KnowledgeNode["kind"];
  position: number;
  note: string;
  body: string;
  visibility: KnowledgeNode["visibility"];
  value_kind: string;
  scalar: string | null;
}
interface DisclosedView {
  collectionPath: string[];
  fields: Record<string, KnowledgeValue>;
}
const DEFAULT_COLLECTIONS = ["Characters", "Locations", "Factions", "Items", "Lore"];
export class KnowledgeIntegrityError extends Error {
}
const normalized = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
const MAX_READ = 100000;
function bounded(n: number | undefined, fallback: number, max = MAX_READ): number {
  if (n === undefined)
    return fallback;
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw new KnowledgeIntegrityError(`Invalid bounded read argument (0..${max})`);
  return n;
}
function validateValue(value: unknown, depth = 0): asserts value is KnowledgeValue {
  if (depth > 64)
    throw new KnowledgeIntegrityError("Knowledge values may nest at most 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value))
    return;
  if (Array.isArray(value)) {
    for (const v of value)
      validateValue(v, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value);
    if (keys.length === 2 && keys.includes("length") && ["$text", "$list", "$object"].some(key => keys.includes(key))) {
      throw new KnowledgeIntegrityError("Read preview descriptors are reserved; read their UID and write actual typed content instead");
    }
    for (const [k, v] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(k))
        throw new KnowledgeIntegrityError("Unsafe knowledge key");
      validateValue(v, depth + 1);
    }
    return;
  }
  throw new KnowledgeIntegrityError("Knowledge values must be finite typed JSON values");
}
/** Synchronous SQLite transactions sit behind one asynchronous, serialized lane. */
export class SqliteKnowledgeStore implements CampaignKnowledgeStore {
  private db: DatabaseSync | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(public readonly path: string, private readonly options: {
    create?: boolean;
    readOnly?: boolean;
  } = {}) { this.open(); }
  private open(): DatabaseSync {
    if (this.db)
      return this.db;
    if (this.path !== ":memory:" && (!this.options.create || this.initialized || this.options.readOnly) && !existsSync(this.path))
      throw new KnowledgeIntegrityError("Campaign knowledge database is missing; create a new campaign");
    if (this.path !== ":memory:" && existsSync(this.path)) {
      const probe = new DatabaseSync(this.path, { readOnly: true });
      try {
        const version = (probe.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version;
        if (version !== 1)
          throw new KnowledgeIntegrityError(`Unsupported knowledge schema version ${version}; create a new campaign`);
        if ((probe.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        }).quick_check !== "ok" || probe.prepare("PRAGMA foreign_key_check").all().length) {
          throw new KnowledgeIntegrityError("Campaign knowledge database integrity check failed");
        }
        if (!probe.prepare("SELECT uid FROM nodes WHERE uid='root'").get())
          throw new KnowledgeIntegrityError("Campaign knowledge root is missing");
      }
      finally {
        probe.close();
      }
    }
    const db = new DatabaseSync(this.path, { readOnly: this.options.readOnly ?? false, enableForeignKeyConstraints: true });
    this.db = db;
    if (this.options.readOnly) {
      // Existing files were validated by a separate read-only connection above.
      return db;
    }
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const v = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (v.user_version !== 0 && v.user_version !== 1)
        throw new KnowledgeIntegrityError(`Unsupported knowledge schema version ${v.user_version}`);
      if (v.user_version === 0) {
        if (this.options.create === false)
          throw new KnowledgeIntegrityError("Campaign knowledge database is missing or uninitialized; create a new campaign");
        db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('next_uid', '1');
    CREATE TABLE nodes (
     uid TEXT PRIMARY KEY, parent TEXT REFERENCES nodes(uid) ON DELETE CASCADE,
     slot TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('collection','entity','value')),
     position INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
     visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','player-facing')),
     value_kind TEXT NOT NULL DEFAULT 'object', scalar TEXT,
     UNIQUE(parent, slot));
    CREATE INDEX children ON nodes(parent,position,uid);
    CREATE TABLE aliases (handle TEXT PRIMARY KEY, display TEXT NOT NULL, uid TEXT NOT NULL REFERENCES nodes(uid) ON DELETE CASCADE);
    CREATE INDEX alias_target ON aliases(uid);
    CREATE TABLE redirects (handle TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES nodes(uid) ON DELETE CASCADE);
    CREATE TABLE refs (source TEXT NOT NULL REFERENCES nodes(uid) ON DELETE CASCADE, target TEXT NOT NULL REFERENCES nodes(uid) ON DELETE RESTRICT, label TEXT NOT NULL, PRIMARY KEY(source,target,label));
    CREATE INDEX reverse_refs ON refs(target);
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL REFERENCES nodes(uid) ON DELETE CASCADE, body TEXT NOT NULL, metadata TEXT NOT NULL);
    CREATE INDEX logs_by_node ON logs(uid,id);
    CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
    INSERT INTO nodes(uid,parent,slot,name,kind,position) VALUES ('root',NULL,'root','Campaign','collection',0);
    PRAGMA user_version=1; COMMIT;`);
        for (const name of DEFAULT_COLLECTIONS)
          this.createCollection("root", name, "");
      }
      this.initialized = true;
      return db;
    }
    catch (error) {
      db.close();
      this.db = null;
      throw error;
    }
  }
  private serialized<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private statement(sql: string) { return this.open().prepare(sql); }
  private row(uid: string): Row {
    const row = this.statement("SELECT * FROM nodes WHERE uid=?").get(uid) as unknown as Row | undefined;
    if (!row)
      throw new KnowledgeIntegrityError(`Knowledge node not found: ${uid}`);
    return row;
  }
  private lookupUid(handle: string): string | null {
    handle = handle.replace(/^@/, "").replace(/^knowledge:/, "");
    if (this.statement("SELECT uid FROM nodes WHERE uid=?").get(handle)) return handle;
    const redirect = this.statement("SELECT uid FROM redirects WHERE handle=?").get(handle) as { uid: string } | undefined;
    return redirect?.uid ?? null;
  }
  private lookup(handle: string): string | null {
    const uid = this.lookupUid(handle);
    if (uid) return uid;
    handle = handle.replace(/^@/, "").replace(/^knowledge:/, "");
    const alias = this.statement("SELECT uid FROM aliases WHERE handle=?").get(normalized(handle)) as {
      uid: string;
    } | undefined;
    if (alias)
      return alias.uid;
    // Legacy-looking handles are accepted only as addresses into new data, never as file reads.
    const parts = handle.replace(/\\/g, "/").replace(/^knowledge:/, "").split("/");
    if (parts.length > 1 && !handle.endsWith(".md")) {
      let current: string | null = "root";
      for (const part of parts)
        current = current ? this.children(current).find(r => normalized(r.name) === normalized(part))?.uid ?? null : null;
      if (current)
        return current;
    }
    const tail = parts.at(-1) === "index.md" ? parts.at(-2) : parts.at(-1)?.replace(/\.md$/, "");
    if (tail) {
      const rows = this.statement("SELECT handle,uid FROM aliases ORDER BY handle").all() as {
        handle: string;
        uid: string;
      }[];
      const slug = (s: string) => normalized(s).replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return rows.find(r => slug(r.handle) === tail)?.uid ?? null;
    }
    return null;
  }
  private require(handle: string): string {
    const uid = this.lookup(handle);
    if (!uid)
      throw new KnowledgeIntegrityError(`Unknown knowledge identity: ${handle}`);
    return uid;
  }
  private allocate(): string {
    const value = Number((this.statement("SELECT value FROM metadata WHERE key='next_uid'").get() as {
      value: string;
    }).value);
    this.statement("UPDATE metadata SET value=? WHERE key='next_uid'").run(String(value + 1));
    return `k${value.toString(36).padStart(4, "0")}`;
  }
  private addAlias(uid: string, name: string): void {
    const handle = normalized(name);
    if (!handle)
      throw new KnowledgeIntegrityError("Names and aliases must be non-empty");
    this.statement("INSERT OR IGNORE INTO aliases(handle,display,uid) VALUES (?,?,?)").run(handle, name.trim(), uid);
  }
  private children(uid: string): Row[] { return this.statement("SELECT * FROM nodes WHERE parent=? ORDER BY position,uid").all(uid) as unknown as Row[]; }
  private insert(parent: string, name: string, kind: Row["kind"], slot?: string, index?: number): string {
    const uid = this.allocate();
    const pos = index ?? this.children(parent).length;
    this.statement("UPDATE nodes SET position=position+1 WHERE parent=? AND position>=?").run(parent, pos);
    this.statement("INSERT INTO nodes(uid,parent,slot,name,kind,position) VALUES (?,?,?,?,?,?)").run(uid, parent, slot ?? uid, name, kind, pos);
    if (kind !== "value")
      this.addAlias(uid, name);
    return uid;
  }
  private createCollection(parent: string, name: string, note: string): string {
    if (this.row(parent).kind !== "collection")
      throw new KnowledgeIntegrityError("Collections must belong to a collection");
    const existing = this.children(parent).find(r => r.kind === "collection" && normalized(r.name) === normalized(name));
    const uid = existing?.uid ?? this.insert(parent, name, "collection");
    if (note)
      this.statement("UPDATE nodes SET note=? WHERE uid=?").run(note, uid);
    return uid;
  }
  private decode(uid: string): KnowledgeValue {
    const row = this.row(uid);
    if (row.value_kind === "list")
      return this.children(uid).map(r => this.decode(r.uid));
    if (row.value_kind === "object")
      return Object.fromEntries(this.children(uid).filter(r => r.kind === "value").map(r => [r.slot, this.decode(r.uid)]));
    return JSON.parse(row.scalar ?? "null") as KnowledgeValue;
  }
  private compact(uid: string, budget = { remaining: 8_000 }, page?: { offset: number; limit: number }): KnowledgeValue {
    const row = this.row(uid);
    budget.remaining -= 24;
    const children = this.children(uid).filter(child => child.kind === "value");
    if (row.value_kind === "object" || row.value_kind === "list") {
      const marker: KnowledgeValue = row.value_kind === "object" ? { $object: uid, length: children.length } : { $list: uid, length: children.length };
      if (budget.remaining <= 0 || (!page && children.length > 32)) return marker;
      const selected = page ? children.slice(page.offset, page.offset + page.limit) : children;
      if (row.value_kind === "list") return selected.map(child => this.compact(child.uid, budget));
      return Object.fromEntries(selected.map(child => {
        budget.remaining -= child.slot.length;
        return [child.slot, this.compact(child.uid, budget)];
      }));
    }
    const value = JSON.parse(row.scalar ?? "null") as KnowledgeValue;
    const length = JSON.stringify(value).length;
    if (typeof value === "string" && (value.length > 256 || length > budget.remaining)) return { $text: uid, length: value.length };
    budget.remaining -= length;
    return value;
  }
  private owner(uid: string): string {
    let row = this.row(uid);
    while (row.kind === "value" && row.parent)
      row = this.row(row.parent);
    return row.uid;
  }
  private transferStructuralOwnership(uid: string, from: string, to: string): void {
    const target = this.structuralReferenceTarget(this.row(uid));
    if (target !== null)
      this.statement("UPDATE refs SET source=? WHERE source=? AND target=? AND label=?").run(to, from, target, `value:${uid}`);
    for (const child of this.children(uid)) this.transferStructuralOwnership(child.uid, from, to);
  }
  private structuralReferenceTarget(row: Row): string | null {
    if (row.kind !== "value" || row.value_kind !== "reference") return null;
    const value = JSON.parse(row.scalar ?? "null") as KnowledgeValue;
    return value && typeof value === "object" && !Array.isArray(value) && typeof value.$ref === "string" ? value.$ref : null;
  }
  private removeStructuralReference(row: Row): void {
    const target = this.structuralReferenceTarget(row);
    // Labels are arbitrary user text. A value: prefix alone does not establish
    // that an edge was generated from this leaf's current typed reference.
    if (target !== null)
      this.statement("DELETE FROM refs WHERE source=? AND target=? AND label=?").run(this.owner(row.uid), target, `value:${row.uid}`);
  }
  private assertDiscardableValues(uid: string): void {
    if (this.statement("SELECT source FROM refs WHERE target=? LIMIT 1").get(uid)) {
      throw new KnowledgeIntegrityError(`Cannot consolidate: referenced value ${uid} would be discarded. Move or reconcile that field before consolidating`);
    }
    for (const child of this.children(uid)) this.assertDiscardableValues(child.uid);
  }
  private setValue(uid: string, value: KnowledgeValue, merge = false): void {
    validateValue(value);
    const row = this.row(uid);
    const isRef = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$ref === "string";
    const kind = isRef ? "reference" : Array.isArray(value) ? "list" : value !== null && typeof value === "object" ? "object" : "scalar";
    const oldObject = row.value_kind === "object";
    if (!merge || kind !== "object" || !oldObject)
      this.removeValueChildren(uid);
    this.removeStructuralReference(row);
    if (kind === "reference") {
      const target = this.require((value as {
        $ref: string;
      }).$ref);
      value = { $ref: target };
      this.statement("INSERT OR IGNORE INTO refs VALUES (?,?,?)").run(this.owner(uid), target, `value:${uid}`);
    }
    this.statement("UPDATE nodes SET value_kind=?,scalar=? WHERE uid=?").run(kind, kind === "scalar" || kind === "reference" ? JSON.stringify(value) : null, uid);
    if (kind === "object") {
      for (const [key, child] of Object.entries(value as Record<string, KnowledgeValue>)) {
        let childRow = this.children(uid).find(r => r.slot === key);
        if (!childRow)
          childRow = this.row(this.insert(uid, key, "value", key));
        this.setValue(childRow.uid, child, merge);
      }
    }
    else if (kind === "list") {
      for (const child of value as KnowledgeValue[]) {
        const childUid = this.insert(uid, "", "value");
        this.setValue(childUid, child);
      }
    }
  }
  private removeValueChildren(uid: string): void {
    for (const child of this.children(uid).filter(r => r.kind === "value")) {
      this.removeValueChildren(child.uid);
      this.removeStructuralReference(child);
      this.statement("DELETE FROM nodes WHERE uid=?").run(child.uid);
    }
  }
  private collectionNames(uid: string): string[] {
    const names: string[] = [];
    let parent = this.row(uid).parent;
    while (parent && parent !== "root") {
      const row = this.row(parent);
      if (row.kind === "collection") names.unshift(row.name);
      parent = row.parent;
    }
    return names;
  }
  private disclosedFields(uid: string): Record<string, KnowledgeValue> {
    const wanted = new Set(["subject", "display_name", "summary", "public_aliases", "public_related", "firstScene", "lastScene"]);
    return Object.fromEntries(this.children(uid).filter(child => child.kind === "value" && wanted.has(child.slot)).map(child => [child.slot, this.decode(child.uid)]));
  }
  private approvedViewSubject(row: Row, fields: Record<string, KnowledgeValue>): string | null {
    const subject = fields.subject;
    const path = this.collectionNames(row.uid);
    if (row.visibility !== "player-facing" || normalized(path[0] ?? "") !== normalized("Player Knowledge") ||
      typeof fields.display_name !== "string" || typeof fields.summary !== "string" ||
      !subject || typeof subject !== "object" || Array.isArray(subject) || typeof subject.$ref !== "string") return null;
    return subject.$ref;
  }
  /** Capture disclosed content before any operation can introduce private facts. */
  private disclosedViews(sceneNumber: number): Map<string, DisclosedView> {
    const views = new Map<string, DisclosedView>();
    const rows = this.statement("SELECT * FROM nodes WHERE kind='entity' AND visibility='player-facing' ORDER BY uid").all() as unknown as Row[];
    for (const row of rows) {
      const fields = this.disclosedFields(row.uid);
      // Approved summaries are already projections; never recursively preserve them.
      if (fields.subject && typeof fields.display_name === "string" && typeof fields.summary === "string") continue;
      views.set(row.uid, {
        collectionPath: this.collectionNames(row.uid),
        fields: {
          subject: { $ref: row.uid }, display_name: row.name, summary: row.body,
          public_aliases: this.identity(row.uid).aliases,
          public_related: Array.isArray(fields.public_related) ? fields.public_related : [],
          firstScene: typeof fields.firstScene === "number" ? fields.firstScene : sceneNumber,
          lastScene: typeof fields.lastScene === "number" ? fields.lastScene : sceneNumber,
        },
      });
    }
    // If a view already existed, its explicitly approved content takes priority
    // over raw canonical content, including when that view is removed this batch.
    for (const row of rows) {
      const fields = this.disclosedFields(row.uid);
      const subject = this.approvedViewSubject(row, fields);
      if (subject && views.has(subject)) views.set(subject, { collectionPath: this.collectionNames(row.uid).slice(1), fields });
    }
    return views;
  }
  private preserveDisclosedView(uid: string, baseline: DisclosedView | undefined): string[] {
    if (!baseline || this.row(uid).visibility !== "player-facing") return [];
    const views = this.statement("SELECT * FROM nodes WHERE kind='entity' AND visibility='player-facing'").all() as unknown as Row[];
    if (views.some(row => this.approvedViewSubject(row, this.disclosedFields(row.uid)) === uid)) return [];
    const changed: string[] = [];
    let parent = this.createCollection("root", "Player Knowledge", "");
    changed.push(parent);
    for (const name of baseline.collectionPath) {
      parent = this.createCollection(parent, name, "");
      changed.push(parent);
    }
    // Insert directly: an unrelated alias or similarly named projection must
    // never redirect this preservation into a different subject's record.
    const view = this.insert(parent, `Player memory: ${uid}`, "entity");
    this.setValue(view, baseline.fields);
    this.statement("UPDATE nodes SET visibility='player-facing' WHERE uid=?").run(view);
    changed.push(view);
    return changed;
  }
  private disclose(uid: string, op: Extract<KnowledgeOperation, { op: "disclose" }>, sceneNumber?: number, baseline?: DisclosedView): string[] {
    const target = this.row(uid);
    if (target.kind !== "entity")
      throw new KnowledgeIntegrityError("disclose requires an existing narrative entity, not a collection or typed value");
    const projectedSubject = this.approvedViewSubject({ ...target, visibility: "player-facing" }, this.disclosedFields(uid));
    if (projectedSubject)
      throw new KnowledgeIntegrityError(`disclose must target canonical UID ${projectedSubject}, not its Player Knowledge projection`);
    if (typeof op.name !== "string" || !op.name.trim() || typeof op.summary !== "string")
      throw new KnowledgeIntegrityError("disclose requires an explicit player-safe name and summary");
    const name = op.name.trim();
    const aliases = new Map<string, string>();
    const rememberAlias = (alias: string) => {
      if (typeof alias !== "string" || !alias.trim())
        throw new KnowledgeIntegrityError("Disclosed aliases must be non-empty strings");
      const key = normalized(alias);
      if (key !== normalized(name) && !aliases.has(key)) aliases.set(key, alias.trim());
    };
    // Direct player-facing records may have no projection yet. Preserve their
    // already disclosed handles from the pre-batch baseline, never current
    // canonical aliases that an earlier operation could have made private.
    if (typeof baseline?.fields.display_name === "string" && baseline.fields.display_name.trim()) rememberAlias(baseline.fields.display_name);
    if (Array.isArray(baseline?.fields.public_aliases)) {
      for (const alias of baseline.fields.public_aliases) if (typeof alias === "string" && alias.trim()) rememberAlias(alias);
    }
    const approved = (this.statement("SELECT * FROM nodes WHERE kind='entity' AND visibility='player-facing' ORDER BY uid").all() as unknown as Row[])
      .map(row => ({ row, fields: this.disclosedFields(row.uid) }))
      .filter(view => this.approvedViewSubject(view.row, view.fields) === uid);
    for (const view of approved) {
      if ((view.fields.display_name as string).trim()) rememberAlias(view.fields.display_name as string);
      if (Array.isArray(view.fields.public_aliases)) {
        for (const alias of view.fields.public_aliases) if (typeof alias === "string" && alias.trim()) rememberAlias(alias);
      }
    }
    for (const alias of op.aliases ?? []) rememberAlias(alias);
    const changed: string[] = [];
    if (!approved.length) {
      let parent = this.createCollection("root", "Player Knowledge", "");
      changed.push(parent);
      for (const collection of this.collectionNames(uid)) {
        parent = this.createCollection(parent, collection, "");
        changed.push(parent);
      }
      const viewUid = this.insert(parent, `Player memory: ${uid}`, "entity");
      this.statement("UPDATE nodes SET visibility='player-facing' WHERE uid=?").run(viewUid);
      approved.push({ row: this.row(viewUid), fields: {} });
    }
    // Several views may survive consolidation. Give every qualified view the
    // same latest explicit disclosure so tree order can never revive old prose.
    for (const view of approved) {
      const fields: Record<string, KnowledgeValue> = {
        subject: { $ref: uid }, display_name: name, summary: op.summary,
        public_aliases: [...aliases.values()],
        firstScene: typeof view.fields.firstScene === "number" ? view.fields.firstScene : sceneNumber ?? 0,
        lastScene: sceneNumber ?? (typeof view.fields.lastScene === "number" ? view.fields.lastScene : 0),
      };
      this.setValue(view.row.uid, fields, true);
      this.appendLog(view.row.uid, `${name}\n\n${op.summary}`, { action: "disclose", ...(sceneNumber === undefined ? {} : { scene: sceneNumber }) });
      changed.push(view.row.uid);
    }
    return changed;
  }
  private patch(uid: string, op: Extract<KnowledgeOperation, {
    op: "patch" | "upsert";
  }>, sceneNumber?: number): void {
    if (op.name !== undefined && op.op === "patch") {
      this.addAlias(uid, op.name);
      this.statement("UPDATE nodes SET name=? WHERE uid=?").run(op.name.trim(), uid);
    }
    for (const alias of op.aliases ?? [])
      this.addAlias(uid, alias);
    if (op.fields !== undefined) {
      validateValue(op.fields);
      this.setValue(uid, op.fields, true);
    }
    if (op.body !== undefined)
      this.statement("UPDATE nodes SET body=? WHERE uid=?").run(op.body, uid);
    if (op.visibility !== undefined)
      this.statement("UPDATE nodes SET visibility=? WHERE uid=?").run(op.visibility, uid);
    if (op.history)
      this.appendLog(uid, op.history, sceneNumber === undefined ? {} : { scene: sceneNumber });
  }
  private appendLog(uid: string, body: string, metadata: Record<string, KnowledgeValue>): void {
    validateValue(metadata);
    const encodedMetadata = JSON.stringify(metadata);
    if (encodedMetadata.length > 4096) throw new KnowledgeIntegrityError("Log metadata is limited to 4096 characters; put bulk text in the log body");
    this.statement("INSERT INTO logs(uid,body,metadata) VALUES (?,?,?)").run(uid, body, encodedMetadata);
  }
  private identity(uid: string) { const r = this.row(uid); return { uid, name: r.name, aliases: (this.statement("SELECT display FROM aliases WHERE uid=? ORDER BY handle").all(uid) as {
      display: string;
    }[]).map(a => a.display) }; }
  resolve(handle: string): Promise<string | null> { return this.serialized(() => this.lookup(handle)); }
  resolveUid(handle: string): Promise<string | null> { return this.serialized(() => this.lookupUid(handle)); }
  outline(): Promise<KnowledgeOutlineEntry[]> {
    return this.serialized(() => (this.statement("SELECT uid,parent,name,kind,note,position FROM nodes ORDER BY parent,position,uid").all() as unknown as KnowledgeOutlineEntry[]));
  }
  private readNode(handle: string, options: KnowledgeReadOptions = {}): KnowledgeNode {
    const uid = this.require(handle);
    const row = this.row(uid);
    const offset = bounded(options.textOffset, 0, Number.MAX_SAFE_INTEGER);
    const limit = bounded(options.textLimit, 12000);
    const logOffset = bounded(options.logOffset, 0, Number.MAX_SAFE_INTEGER);
    const logLimit = bounded(options.logLimit, 30, 1000);
    const logTextOffset = bounded(options.logTextOffset, 0, Number.MAX_SAFE_INTEGER);
    const logTextLimit = bounded(options.logTextLimit, 500);
    const childOffset = bounded(options.childOffset, 0, Number.MAX_SAFE_INTEGER);
    const childLimit = bounded(options.childLimit, 30, 1000);
    const logs = (options.logEntryId === undefined ? this.statement("SELECT id,body,metadata FROM logs WHERE uid=? ORDER BY id LIMIT ? OFFSET ?").all(uid, logLimit, logOffset) : this.statement("SELECT id,body,metadata FROM logs WHERE uid=? AND id=?").all(uid, bounded(options.logEntryId, 0, Number.MAX_SAFE_INTEGER))) as {
      id: number;
      body: string;
      metadata: string;
    }[];
    const logCount = (this.statement("SELECT count(*) AS n FROM logs WHERE uid=?").get(uid) as {
      n: number;
    }).n;
    const value = row.kind === "value" && row.value_kind === "scalar" ? this.decode(uid) : this.compact(uid, undefined, { offset: childOffset, limit: childLimit });
    const children = this.children(uid);
    const scalarText = row.kind === "value" && typeof value === "string" ? value : row.body;
    return { ...this.identity(uid), parent: row.parent, name: row.name, kind: row.kind, position: row.position, note: row.note,
      fields: row.kind === "value" || Array.isArray(value) || value === null || typeof value !== "object" ? {} : value,
      ...(row.kind === "value" ? { value: typeof value === "string" ? value.slice(offset, offset + limit) : value } : {}), body: row.body.slice(offset, offset + limit), textLength: scalarText.length,
      visibility: row.visibility, references: this.statement("SELECT source,target,label FROM refs WHERE source=? ORDER BY label,target").all(uid) as unknown as KnowledgeReference[],
      logs: logs.map(l => ({ ...l, body: l.body.slice(logTextOffset, logTextOffset + logTextLimit), textLength: l.body.length,
        ...(logTextOffset + logTextLimit < l.body.length ? { textNextOffset: logTextOffset + logTextLimit } : {}), metadata: JSON.parse(l.metadata) as KnowledgeLogEntry["metadata"] })), logCount,
      children: children.slice(childOffset, childOffset + childLimit).map(r => ({ uid: r.uid, parent: r.parent, name: r.name, kind: r.kind, note: r.note, position: r.position })), childCount: children.length,
      ...(offset + limit < scalarText.length ? { textNextOffset: offset + limit } : {}), ...(options.logEntryId === undefined && logOffset + logs.length < logCount ? { logNextOffset: logOffset + logs.length } : {}) };
  }
  read(handle: string, options?: KnowledgeReadOptions): Promise<KnowledgeNode> { return this.serialized(() => this.readNode(handle, options)); }
  snapshot(): Promise<string> {
    return this.serialized(() => {
      const rows = this.statement("SELECT * FROM nodes ORDER BY parent,position,uid").all() as unknown as Row[];
      const byUid = new Map(rows.map(row => [row.uid, row]));
      const children = new Map<string, Row[]>();
      for (const row of rows) {
        if (!row.parent) continue;
        const siblings = children.get(row.parent) ?? [];
        siblings.push(row);
        children.set(row.parent, siblings);
      }
      const aliases = new Map<string, string[]>();
      for (const alias of this.statement("SELECT uid,display FROM aliases ORDER BY uid,handle").all() as { uid: string; display: string }[]) {
        const names = aliases.get(alias.uid) ?? [];
        names.push(alias.display);
        aliases.set(alias.uid, names);
      }
      const logCounts = new Map((this.statement("SELECT uid,count(*) AS n FROM logs GROUP BY uid").all() as { uid: string; n: number }[]).map(row => [row.uid, row.n]));
      const links = new Map<string, KnowledgeReference[]>();
      for (const reference of this.statement("SELECT source,target,label FROM refs ORDER BY source,label,target").all() as unknown as KnowledgeReference[]) {
        // A structural edge is already visible on its typed reference leaf.
        // Keep every explicit edge, even a value:* label that does not match
        // the indexed source/target of an actual typed reference node.
        if (reference.label.startsWith("value:")) {
          const leaf = byUid.get(reference.label.slice("value:".length));
          if (leaf?.kind === "value" && leaf.value_kind === "reference") {
            let owner = leaf;
            while (owner.kind === "value" && owner.parent) {
              const parent = byUid.get(owner.parent);
              if (!parent) throw new KnowledgeIntegrityError("Knowledge snapshot has an orphaned reference node");
              owner = parent;
            }
            const target = (JSON.parse(leaf.scalar ?? "null") as { $ref: string } | null)?.$ref;
            if (owner.uid === reference.source && target === reference.target) continue;
          }
        }
        const outgoing = links.get(reference.source) ?? [];
        outgoing.push(reference);
        links.set(reference.source, outgoing);
      }
      const inlineName = (name: string) => /[\r\n\t]/.test(name) ? JSON.stringify(name) : name;
      const inlineLabel = (label: string) => !label || /[\r\n\t;]|->/.test(label) ? JSON.stringify(label) : label;
      const lines: string[] = [];
      const walk = (row: Row, depth: number) => {
        const parent = row.parent ? byUid.get(row.parent) : undefined;
        const name = inlineName(row.name || row.slot);
        const address = parent?.value_kind === "list" ? `[${row.position}]${row.name ? ` ${inlineName(row.name)}` : ""}` : name;
        let detail = "";
        if (row.kind === "collection") detail = "/";
        else if (row.kind === "value") {
          if (row.value_kind === "object") detail = " {}";
          else if (row.value_kind === "list") detail = " []";
          else {
            const scalar = JSON.parse(row.scalar ?? "null") as KnowledgeValue;
            if (row.value_kind === "reference") detail = ` -> ${(scalar as { $ref: string }).$ref}`;
            else detail = typeof scalar === "string" && scalar.length > 160 ? ` = (text ${scalar.length} chars)` : ` = ${JSON.stringify(scalar)}`;
          }
        }
        const otherNames = (aliases.get(row.uid) ?? []).filter(alias => normalized(alias) !== normalized(row.name));
        const aka = otherNames.length ? ` aka ${otherNames.map(alias => JSON.stringify(alias)).join(", ")}` : "";
        const bulk = [row.body.length ? `body ${row.body.length} chars` : "", logCounts.get(row.uid) ? `${logCounts.get(row.uid)} log${logCounts.get(row.uid) === 1 ? "" : "s"}` : ""].filter(Boolean);
        const note = row.note ? ` — ${inlineName(row.note.slice(0, 180))}${row.note.length > 180 ? "…" : ""}` : "";
        const outgoing = links.get(row.uid) ?? [];
        const edges = outgoing.length ? `; links: ${outgoing.map(reference => `${inlineLabel(reference.label)} -> ${reference.target}`).join("; ")}` : "";
        lines.push(`${"  ".repeat(depth)}${row.uid} ${address}${detail}${aka}${bulk.length ? ` (${bulk.join(", ")})` : ""}${note}${edges}`);
        for (const child of children.get(row.uid) ?? []) walk(child, depth + 1);
      };
      const root = byUid.get("root");
      if (!root) throw new KnowledgeIntegrityError("Campaign knowledge root is missing");
      walk(root, 0);
      return lines.join("\n");
    });
  }
  mutate(operations: KnowledgeOperation[], options: KnowledgeMutationOptions = {}): Promise<KnowledgeMutationResult> {
    return this.serialized(() => {
      if (this.options.readOnly)
        throw new KnowledgeIntegrityError("Knowledge store is read-only");
      const db = this.open();
      const payload = JSON.stringify({ operations, sceneNumber: options.sceneNumber, source: options.source });
      if (options.operationId) {
        const previous = this.statement("SELECT payload,result FROM operations WHERE id=?").get(options.operationId) as {
          payload: string;
          result: string;
        } | undefined;
        if (previous) {
          if (previous.payload !== payload)
            throw new KnowledgeIntegrityError("Operation ID was reused for different mutations");
          return JSON.parse(previous.result) as KnowledgeMutationResult;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const disclosed = this.disclosedViews(options.sceneNumber ?? 0);
        const changed = new Set<string>();
        const identityUids = new Set<string>();
        const candidates = new Set<string>();
        const touch = (uid: string) => {
          const owner = this.owner(uid);
          changed.add(owner);
          identityUids.add(owner);
          const targets = new Set<string>([uid, owner]);
          const descend = (node: string) => { for (const child of this.children(node)) {
            targets.add(child.uid);
            descend(child.uid);
          } };
          descend(uid);
          let ancestor = this.row(uid).parent;
          while (ancestor) {
            targets.add(ancestor);
            ancestor = this.row(ancestor).parent;
          }
          // Retrieve direct and one-hop-indirect dependents only. A
          // visited set prevents cycles; these remain candidates, not
          // automatic narrative changes or inferred relationships.
          let frontier = targets;
          const visited = new Set<string>([owner]);
          for (let depth = 0; depth < 2 && frontier.size; depth++) {
            const next = new Set<string>();
            for (const target of frontier) {
              const incoming = this.statement("SELECT source FROM refs WHERE target=?").all(target) as { source: string }[];
              for (const reference of incoming) {
                const dependent = this.owner(reference.source);
                if (visited.has(dependent)) continue;
                visited.add(dependent);
                candidates.add(dependent);
                next.add(dependent);
              }
            }
            frontier = next;
          }
        };
        for (const op of operations) {
          switch (op.op) {
            case "create_collection": {
              const uid = this.createCollection(op.parent ? this.require(op.parent) : "root", op.name, op.note ?? "");
              touch(uid);
              break;
            }
            case "upsert": {
              const parent = this.require(op.collection);
              if (this.row(parent).kind !== "collection")
                throw new KnowledgeIntegrityError("Entity parent must be a collection");
              let uid = op.uid ? this.require(op.uid) : op.name ? this.lookup(op.name) : null;
              if (!uid) {
                if (!op.name?.trim())
                  throw new KnowledgeIntegrityError("Creating an identity requires a name");
                uid = this.insert(parent, op.name.trim(), "entity");
              }
              else if (this.row(uid).kind !== "entity")
                throw new KnowledgeIntegrityError("Name resolves to a collection or value; supply a different identity name");
              touch(uid);
              if (op.visibility === "private") {
                for (const preserved of this.preserveDisclosedView(uid, disclosed.get(uid))) touch(preserved);
              }
              this.patch(uid, op, options.sceneNumber);
              break;
            }
            case "patch": {
              const uid = this.require(op.uid);
              touch(uid);
              if (op.visibility === "private") {
                for (const preserved of this.preserveDisclosedView(uid, disclosed.get(uid))) touch(preserved);
              }
              this.patch(uid, op, options.sceneNumber);
              break;
            }
            case "disclose": {
              const uid = this.require(op.uid);
              for (const changedUid of this.disclose(uid, op, options.sceneNumber, disclosed.get(uid))) touch(changedUid);
              identityUids.add(uid);
              break;
            }
            case "remove_fields": {
              const uid = this.require(op.uid);
              touch(uid);
              for (const key of op.keys) {
                const child = this.children(uid).find(r => r.slot === key && r.kind === "value");
                if (child) {
                  this.removeValueChildren(child.uid);
                  this.removeStructuralReference(child);
                  this.statement("DELETE FROM nodes WHERE uid=?").run(child.uid);
                }
              }
              break;
            }
            case "append_log": {
              const uid = this.require(op.uid);
              touch(uid);
              const metadata = { ...op.metadata };
              if (options.sceneNumber !== undefined && !Object.hasOwn(metadata, "scene") && !Object.hasOwn(metadata, "sceneNumber"))
                metadata.scene = options.sceneNumber;
              this.appendLog(uid, op.body, metadata);
              break;
            }
            case "append_text": {
              const uid = this.require(op.uid);
              const row = this.row(uid);
              if (row.kind === "value") {
                const value = this.decode(uid);
                if (row.value_kind !== "scalar" || typeof value !== "string")
                  throw new KnowledgeIntegrityError("append_text requires a string value; use set_value for other typed values");
                touch(uid);
                this.setValue(uid, value + op.text);
              } else {
                touch(uid);
                this.statement("UPDATE nodes SET body=body||? WHERE uid=?").run(op.text, uid);
              }
              break;
            }
            case "create_node": {
              const parent = this.require(op.parent);
              if (!["object", "list"].includes(this.row(parent).value_kind))
                throw new KnowledgeIntegrityError("Parent must hold an object or ordered list");
              const uid = this.insert(parent, op.name ?? "", "value", this.row(parent).value_kind === "list" ? undefined : op.name, op.index);
              this.setValue(uid, op.value);
              touch(uid);
              identityUids.add(uid);
              break;
            }
            case "set_value": {
              const uid = this.require(op.uid);
              if (this.row(uid).kind !== "value")
                throw new KnowledgeIntegrityError("set_value addresses a value node");
              touch(uid);
              this.setValue(uid, op.value);
              break;
            }
            case "add_reference":
            case "remove_reference": {
              const source = this.require(op.source);
              const target = this.require(op.target);
              touch(source);
              if (op.op === "add_reference")
                this.statement("INSERT OR IGNORE INTO refs VALUES (?,?,?)").run(source, target, op.label ?? "depends_on");
              else
                this.statement("DELETE FROM refs WHERE source=? AND target=? AND label=?").run(source, target, op.label ?? "depends_on");
              break;
            }
            case "move": {
              const uid = this.require(op.uid);
              const parent = this.require(op.parent);
              touch(uid);
              const oldOwner = this.owner(uid);
              touch(parent);
              if (uid === "root")
                throw new KnowledgeIntegrityError("Cannot move campaign root");
              let ancestor: string | null = parent;
              while (ancestor) {
                if (ancestor === uid)
                  throw new KnowledgeIntegrityError("A tree node cannot be its own ancestor");
                ancestor = this.row(ancestor).parent;
              }
              if (this.row(uid).kind !== "value" ? this.row(parent).kind !== "collection" : !["list", "object"].includes(this.row(parent).value_kind))
                throw new KnowledgeIntegrityError("Identities move between collections; values move between objects/lists");
              const index = bounded(op.index, this.children(parent).length, Number.MAX_SAFE_INTEGER);
              this.statement("UPDATE nodes SET position=position+1 WHERE parent=? AND position>=?").run(parent, index);
              this.statement("UPDATE nodes SET parent=?,position=?,slot=? WHERE uid=?").run(parent, index, this.row(parent).value_kind === "list" ? uid : this.row(uid).slot, uid);
              const newOwner = this.owner(uid);
              if (oldOwner !== newOwner) this.transferStructuralOwnership(uid, oldOwner, newOwner);
              break;
            }
            case "consolidate": {
              const uid = this.require(op.uid);
              const target = this.require(op.target);
              if (uid === target)
                break;
              if (this.row(uid).kind !== "entity" || this.row(target).kind !== "entity")
                throw new KnowledgeIntegrityError("Only narrative identities can be consolidated");
              if (this.row(uid).visibility !== this.row(target).visibility)
                throw new KnowledgeIntegrityError("Cannot consolidate public and private identities: make both private first to preserve their disclosed views, then consolidate");
              touch(uid);
              touch(target);
              const targetSlots = new Set(this.children(target).map(child => child.slot));
              for (const child of this.children(uid).filter(child => child.kind === "value")) {
                if (targetSlots.has(child.slot)) {
                  // Winner fields remain authoritative. An external leaf
                  // dependency cannot silently lose its referenced value.
                  this.assertDiscardableValues(child.uid);
                  continue;
                }
                // Rehome missing fields instead of copying: every nested
                // value/card UID and incoming reference survives unchanged.
                this.statement("UPDATE nodes SET parent=?,position=? WHERE uid=?").run(target, this.children(target).length, child.uid);
                this.transferStructuralOwnership(child.uid, uid, target);
              }
              const src = this.row(uid);
              const dst = this.row(target);
              this.statement("UPDATE nodes SET body=? WHERE uid=?").run([dst.body, src.body].filter(Boolean).join("\n\n"), target);
              this.statement("UPDATE aliases SET uid=? WHERE uid=?").run(target, uid);
              this.statement("UPDATE redirects SET uid=? WHERE uid=?").run(target, uid);
              this.statement("INSERT OR REPLACE INTO redirects VALUES (?,?)").run(uid, target);
              const refs = this.statement("SELECT source,target,label FROM refs WHERE source=? OR target=?").all(uid, uid) as unknown as KnowledgeReference[];
              this.statement("DELETE FROM refs WHERE source=? OR target=?").run(uid, uid);
              for (const ref of refs) {
                // Remaining source-owned fields will be discarded below. Drop
                // only their actual derived edges, not arbitrary explicit
                // labels that happen to use the same value: spelling.
                const leaf = ref.source === uid && ref.label.startsWith("value:")
                  ? this.statement("SELECT * FROM nodes WHERE uid=?").get(ref.label.slice(6)) as Row | undefined
                  : undefined;
                if (leaf && this.owner(leaf.uid) === uid && this.structuralReferenceTarget(leaf) === ref.target) continue;
                this.statement("INSERT OR IGNORE INTO refs VALUES (?,?,?)").run(ref.source === uid ? target : ref.source, ref.target === uid ? target : ref.target, ref.label);
              }
              for (const valueRow of this.statement("SELECT uid,scalar FROM nodes WHERE value_kind='reference'").all() as {
                uid: string;
                scalar: string;
              }[]) {
                if ((JSON.parse(valueRow.scalar) as {
                  $ref: string;
                }).$ref === uid)
                  this.statement("UPDATE nodes SET scalar=? WHERE uid=?").run(JSON.stringify({ $ref: target }), valueRow.uid);
              }
              this.statement("UPDATE logs SET uid=? WHERE uid=?").run(target, uid);
              this.removeValueChildren(uid);
              this.statement("DELETE FROM nodes WHERE uid=?").run(uid);
              identityUids.delete(uid);
              break;
            }
            case "delete": {
              const uid = this.require(op.uid);
              if (uid === "root")
                throw new KnowledgeIntegrityError("Cannot delete campaign root");
              touch(uid);
              this.removeValueChildren(uid);
              this.statement("DELETE FROM nodes WHERE uid=?").run(uid);
              identityUids.delete(uid);
              break;
            }
            default: throw new KnowledgeIntegrityError("Unknown knowledge operation");
          }
        }
        const result: KnowledgeMutationResult = { identities: [...identityUids].map(uid => this.identity(uid)), changed: [...changed], candidates: [...candidates].sort() };
        if (changed.size) {
          // Outbox rows are indivisible delivery units. Chunk large batches
          // without truncating any identity or dependency candidate.
          const count = Math.max(Math.ceil(result.changed.length / 50), Math.ceil(result.identities.length / 50), Math.ceil(result.candidates.length / 100));
          for (let index = 0; index < count; index++) {
            const notice: Omit<KnowledgeNotice, "id"> = {
              source: options.source ?? "campaign",
              changed: result.changed.slice(index * 50, (index + 1) * 50),
              identities: result.identities.slice(index * 50, (index + 1) * 50),
              candidates: result.candidates.slice(index * 100, (index + 1) * 100),
            };
            const noticeId = Number(this.statement("INSERT INTO notices(payload) VALUES (?)").run(JSON.stringify(notice)).lastInsertRowid);
            result.noticeId ??= noticeId;
          }
        }
        if (options.operationId)
          this.statement("INSERT INTO operations VALUES (?,?,?)").run(options.operationId, payload, JSON.stringify(result));
        db.exec("COMMIT");
        return result;
      }
      catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  pendingNotices(): Promise<KnowledgeNotice[]> {
    return this.serialized(() => {
      const rows = this.statement("SELECT id,payload FROM notices ORDER BY id").all() as { id: number; payload: string }[];
      return rows.map(row => ({ ...JSON.parse(row.payload) as Omit<KnowledgeNotice, "id">, id: row.id }));
    });
  }
  acknowledgeNotices(ids: number[]): Promise<void> {
    return this.serialized(() => {
      if (this.options.readOnly) throw new KnowledgeIntegrityError("Knowledge store is read-only");
      const db = this.open();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids) this.statement("DELETE FROM notices WHERE id=?").run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async flush(): Promise<void> {
    await this.queue;
  }
  close(): Promise<void> {
    return this.serialized(() => {
      if (this.path !== ":memory:") {
        this.db?.close();
        this.db = null;
      }
    });
  }
  withSnapshot<T>(capture: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      if (this.path !== ":memory:") {
        this.db?.close();
        this.db = null;
      }
      // A failed callback leaves the handle closed and preserves its error.
      // Archive may remove the source; never recreate that database.
      const result = await capture();
      if (!this.options.readOnly && (this.path === ":memory:" || existsSync(this.path))) this.open();
      return result;
    });
  }
}
