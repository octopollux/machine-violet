/**
 * Entity store — the single owner of file I/O for file-backed entities.
 *
 * Everything that reads, writes, indexes, or deletes an entity file should
 * route through here. Scribe, the new `entity` tool, and the campaign-ops
 * refactor tools (rename/merge/resolve-dead-links) all sit on top of this.
 *
 * Encapsulates:
 *   - The location-subdir quirk (`locations/<slug>/index.md` vs flat `.md`)
 *   - Frontmatter parse/serialize
 *   - Wikilink-aware delete (surfaces inbound refs that become dead)
 *   - Observed-field scanning for schema drift
 */

import { join, dirname } from "node:path";
import { parseFrontMatter, serializeEntity } from "../tools/filesystem/frontmatter.js";
import { formatChangelogEntry } from "../tools/filesystem/changelog.js";
import { campaignPaths } from "../tools/filesystem/scaffold.js";
import { findReferences } from "../tools/campaign-ops/find-references.js";
import { walkCampaignFiles } from "../tools/campaign-ops/walk-campaign.js";
import { extractWikilinks } from "../tools/filesystem/wikilinks.js";
import { resolveRelativePath } from "../tools/filesystem/validation.js";
import { norm } from "../utils/paths.js";
import { slugify } from "@machine-violet/shared/utils/slug.js";
import {
  FILE_BACKED_ENTITY_TYPES,
  getEntitySchema,
  isFileBackedEntityType,
  type FileBackedEntityType,
  type EntitySchema,
} from "@machine-violet/shared/schemas/entities/index.js";
import type {
  EntityFrontMatter,
  EntityTree,
} from "@machine-violet/shared/types/entities.js";

// --- I/O surface ---

/**
 * Minimal FileIO subset the store needs. Matches the structural shape of
 * `scene-manager`'s FileIO so production callers can pass that straight in,
 * but pulls in only what we touch so tests don't have to mock the rest.
 */
export interface EntityFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  /** Required for delete + rename-after-delete cleanup. */
  deleteFile?(path: string): Promise<void>;
  /** Optional cleanup of the location subdir on delete. Tolerates non-empty dirs. */
  rmdir?(path: string): Promise<void>;
}

// --- Public types ---

/**
 * Rich entity record returned by `read`. Verbose by design — agents learn the
 * data shape from these responses, so we don't truncate or hide fields.
 */
export interface EntityRecord {
  type: FileBackedEntityType;
  id: string;
  displayName: string;
  aliases: string[];

  /** The on-disk markdown, verbatim, for round-trip safety. */
  raw: string;
  /** Parsed body (everything between front matter and `## Changelog`). */
  body: string;
  /** Parsed front-matter, with `_title` stripped. */
  frontMatter: Record<string, unknown>;
  /** Parsed `## Changelog` entries, one per line, leading `- ` stripped. */
  changelog: string[];

  schema: {
    version: string;
    knownFields: string[];
    required: string[];
    /** Pointer agents can quote to learn more. */
    source: string;
  };

  validation: {
    status: "ok" | "warnings" | "errors";
    issues: ValidationIssue[];
  };

  references: {
    /** Wikilink targets emitted from this entity's body, resolved to `type:slug` when possible. */
    outbound: string[];
    /** Other entities (and other files) that link to this entity. */
    inbound: string[];
    /** Outbound targets that don't resolve to an existing entity. */
    dead: string[];
  };

  drift: {
    /** Front-matter keys present in the file but not in the declared schema. */
    unknownFields: string[];
    /** Declared required fields absent from this entity. */
    missingFields: string[];
  };
}

export interface ValidationIssue {
  level: "warning" | "error";
  field?: string;
  msg: string;
}

export interface ListEntry {
  id: string;
  displayName: string;
  aliases: string[];
  /** Path relative to campaign root (forward slashes). */
  path: string;
}

/**
 * Payload accepted by create/update. Lightly typed — entity contents are
 * markdown-shaped, so the tool surface stays close to the underlying file.
 */
export interface EntityPatch {
  /** Display name. Required on create; ignored on update unless explicitly set. */
  displayName?: string;
  /** Front-matter merge (per update semantics — `null` deletes a key). */
  frontMatter?: Record<string, unknown>;
  /** Body markdown. On update, section-aware replacement is delegated to the caller. */
  body?: string;
  /** Changelog entry (formatted with scene number by the store). */
  changelogEntry?: string;
}

export interface DeleteResult {
  type: FileBackedEntityType;
  id: string;
  /** Path that was removed (relative). */
  path: string;
  /** Inbound references that are now dead (were valid before delete). */
  deadReferences: { file: string; line: number; display: string }[];
}

export interface ObservedField {
  /** How many entities of this type have the field set. */
  occursIn: number;
  /** Up to five example slugs (deterministic order). */
  examples: string[];
}

/** Per-type observed-field summary. */
export type ObservedFields = Record<string, ObservedField>;

// --- Store ---

export class EntityStore {
  /**
   * Skip these filenames when scanning entity dirs — they're conventional
   * non-entity files (party roster, scratch notes) that share the directory.
   */
  private static readonly SKIP_FILES = new Set(["party.md", "notes.md"]);

  /** Cached scan results, keyed by entity type. Cleared on writes. */
  private observedCache = new Map<FileBackedEntityType, ObservedFields>();
  /** Cached entity tree. Cleared on writes. */
  private treeCache: EntityTree | null = null;

  constructor(
    public readonly campaignRoot: string,
    private readonly fileIO: EntityFileIO,
  ) {}

  // ── Path encapsulation ──

  /**
   * Resolve `<type>/<id>` to absolute and relative paths. Encapsulates the
   * location-subdir quirk; nothing outside this class needs to know about it.
   */
  pathFor(type: FileBackedEntityType, id: string): { abs: string; rel: string } {
    const paths = campaignPaths(this.campaignRoot);
    const slug = slugify(id);
    let abs: string;
    switch (type) {
      case "character": abs = paths.character(slug); break;
      case "location":  abs = paths.location(slug);  break;
      case "faction":   abs = paths.faction(slug);   break;
      case "lore":      abs = paths.lore(slug);      break;
      case "item":      abs = paths.item(slug);      break;
    }
    const normRoot = norm(this.campaignRoot);
    const normAbs = norm(abs);
    const rel = normAbs.startsWith(normRoot + "/")
      ? normAbs.slice(normRoot.length + 1)
      : normAbs;
    return { abs: normAbs, rel };
  }

  /** Resolve the directory that holds all entities of a type. */
  dirFor(type: FileBackedEntityType): string {
    return norm(join(this.campaignRoot, getEntitySchema(type).storage.dir));
  }

  /** True if the entity exists on disk. */
  async exists(type: FileBackedEntityType, id: string): Promise<boolean> {
    const { abs } = this.pathFor(type, id);
    return this.fileIO.exists(abs);
  }

  // ── Cache management ──

  private invalidateCaches(): void {
    this.observedCache.clear();
    this.treeCache = null;
  }

  // ── Index / list ──

  /**
   * Build the campaign-wide entity tree by scanning all entity directories.
   * Replaces the standalone `buildEntityTree` from `entity-tree.ts`.
   */
  async scanIndex(): Promise<EntityTree> {
    if (this.treeCache) return this.treeCache;

    const tree: EntityTree = {};

    for (const type of FILE_BACKED_ENTITY_TYPES) {
      const entries = await this.listSlugsOnDisk(type);
      for (const slug of entries) {
        try {
          const { abs, rel } = this.pathFor(type, slug);
          const raw = await this.fileIO.readFile(abs);
          const parsed = parseFrontMatter(raw);
          const name = (parsed.frontMatter._title as string | undefined) ?? slug;
          const aliases = this.parseAliases(parsed.frontMatter.additional_names);
          tree[slug] = { name, aliases, type, path: rel };
        } catch {
          // Skip unreadable / malformed files; validate_entity will surface them.
        }
      }
    }

    this.treeCache = tree;
    return tree;
  }

  /** List on-disk entities of a type. */
  async list(type: FileBackedEntityType): Promise<ListEntry[]> {
    const slugs = await this.listSlugsOnDisk(type);
    const out: ListEntry[] = [];
    for (const slug of slugs) {
      try {
        const { abs, rel } = this.pathFor(type, slug);
        const raw = await this.fileIO.readFile(abs);
        const parsed = parseFrontMatter(raw);
        out.push({
          id: slug,
          displayName: (parsed.frontMatter._title as string | undefined) ?? slug,
          aliases: this.parseAliases(parsed.frontMatter.additional_names),
          path: rel,
        });
      } catch {
        // Malformed file — still surface it so the caller knows it's there.
        const { rel } = this.pathFor(type, slug);
        out.push({ id: slug, displayName: slug, aliases: [], path: rel });
      }
    }
    return out;
  }

  /** Lower-level: enumerate the slugs on disk without reading files. */
  private async listSlugsOnDisk(type: FileBackedEntityType): Promise<string[]> {
    const schema = getEntitySchema(type);
    const dir = this.dirFor(type);

    // Skip the exists() precheck — it's racy and not all FileIO impls report
    // directories as "exists". The listDir try/catch handles the
    // missing-directory case directly.
    let entries: string[];
    try {
      entries = await this.fileIO.listDir(dir);
    } catch { return []; }

    const slugs: string[] = [];
    for (const entry of entries) {
      if (EntityStore.SKIP_FILES.has(entry)) continue;
      if (schema.storage.subdirs && !entry.endsWith(".md")) {
        // Subdir-per-entity: confirm index.md is present
        const indexPath = norm(join(dir, entry, "index.md"));
        if (await this.fileIO.exists(indexPath)) slugs.push(entry);
      } else if (!schema.storage.subdirs && entry.endsWith(".md")) {
        slugs.push(entry.replace(/\.md$/, ""));
      }
    }
    slugs.sort();
    return slugs;
  }

  // ── Read ──

  async read(type: FileBackedEntityType, id: string): Promise<EntityRecord> {
    const slug = slugify(id);
    const { abs, rel } = this.pathFor(type, slug);
    if (!(await this.fileIO.exists(abs))) {
      throw new EntityNotFoundError(type, slug);
    }
    const raw = await this.fileIO.readFile(abs);
    const parsed = parseFrontMatter(raw);
    const schema = getEntitySchema(type);

    // Clean frontmatter — strip internal `_title` which we expose via displayName.
    const cleanFm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.frontMatter)) {
      if (!k.startsWith("_")) cleanFm[k] = v;
    }
    const displayName = (parsed.frontMatter._title as string | undefined) ?? slug;
    const aliases = this.parseAliases(cleanFm.additional_names);

    const refs = await this.collectReferences(type, slug, rel, parsed.body);
    const drift = this.computeDrift(schema, cleanFm);
    const validation = this.runValidation(schema, displayName, cleanFm, refs);

    return {
      type,
      id: slug,
      displayName,
      aliases,
      raw,
      body: parsed.body,
      frontMatter: cleanFm,
      changelog: parsed.changelog,
      schema: {
        version: schema.version,
        knownFields: Object.keys(schema.fields),
        required: Object.entries(schema.fields).filter(([, f]) => f.required).map(([k]) => k),
        source: `describe_entity_type('${type}')`,
      },
      validation,
      references: refs,
      drift,
    };
  }

  // ── Create / update ──

  /**
   * Create a new entity. `id` is derived from `patch.displayName` (slugified).
   * Throws if the entity already exists.
   *
   * `sceneNumber` is woven into the changelog entry if provided. Tests and
   * out-of-scene callers can pass 0 (renders as `Scene 000`).
   */
  async create(
    type: FileBackedEntityType,
    patch: EntityPatch,
    sceneNumber = 0,
  ): Promise<EntityRecord> {
    if (!patch.displayName || !patch.displayName.trim()) {
      throw new EntityValidationError("create requires a displayName");
    }
    const slug = slugify(patch.displayName);
    const { abs } = this.pathFor(type, slug);
    if (await this.fileIO.exists(abs)) {
      throw new EntityValidationError(`Entity already exists: ${type}/${slug}`);
    }

    await this.fileIO.mkdir(dirname(abs));

    const fm: EntityFrontMatter = {
      type,
      ...(patch.frontMatter ?? {}),
    };
    const changelog: string[] = [];
    if (patch.changelogEntry) {
      changelog.push(formatChangelogEntry(sceneNumber, patch.changelogEntry));
    }
    const content = serializeEntity(patch.displayName, fm, patch.body ?? "", changelog);
    await this.fileIO.writeFile(abs, content);
    this.invalidateCaches();
    return this.read(type, slug);
  }

  /**
   * Partial update. Front-matter values of `null` delete the corresponding
   * key. Body is replaced wholesale by `patch.body` if provided — callers
   * that want section-aware merging should compose the body first (see
   * `mergeSectionBodies` in scribe).
   */
  async update(
    type: FileBackedEntityType,
    id: string,
    patch: EntityPatch,
    sceneNumber = 0,
  ): Promise<EntityRecord> {
    const slug = slugify(id);
    const { abs } = this.pathFor(type, slug);
    if (!(await this.fileIO.exists(abs))) {
      throw new EntityNotFoundError(type, slug);
    }
    const raw = await this.fileIO.readFile(abs);
    const parsed = parseFrontMatter(raw);
    const title = patch.displayName?.trim()
      || (parsed.frontMatter._title as string | undefined)
      || slug;

    const fm: EntityFrontMatter = { ...parsed.frontMatter };
    delete (fm as Record<string, unknown>)._title;
    if (patch.frontMatter) {
      for (const [k, v] of Object.entries(patch.frontMatter)) {
        if (v === null) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete (fm as Record<string, unknown>)[k];
        } else {
          (fm as Record<string, unknown>)[k] = v;
        }
      }
    }

    const body = patch.body !== undefined ? patch.body : parsed.body;
    const changelog = [...parsed.changelog];
    if (patch.changelogEntry) {
      changelog.push(formatChangelogEntry(sceneNumber, patch.changelogEntry));
    }
    const content = serializeEntity(title, fm, body, changelog);
    await this.fileIO.writeFile(abs, content);
    this.invalidateCaches();
    return this.read(type, slug);
  }

  // ── Delete ──

  /**
   * Delete an entity. Returns the inbound references that just became dead.
   *
   * We don't auto-rewrite or stub anything — that's the job of
   * `resolve_dead_links` or an explicit `rename`. Surfacing the orphaned
   * refs lets the caller decide.
   */
  async delete(type: FileBackedEntityType, id: string): Promise<DeleteResult> {
    if (!this.fileIO.deleteFile) {
      throw new EntityValidationError("delete requires fileIO.deleteFile");
    }
    const slug = slugify(id);
    const { abs, rel } = this.pathFor(type, slug);
    if (!(await this.fileIO.exists(abs))) {
      throw new EntityNotFoundError(type, slug);
    }

    // Capture inbound refs BEFORE deletion — once the file is gone, the next
    // `walk` won't see it as a target, but the caller still wants to know
    // which links now dangle.
    const refResult = await findReferences(this.campaignRoot, this.fileIO as Parameters<typeof findReferences>[1], rel);

    await this.fileIO.deleteFile(abs);

    // Best-effort cleanup of the location subdir. Leaves it in place if a
    // map JSON is still parked there.
    const schema = getEntitySchema(type);
    if (schema.storage.subdirs && this.fileIO.rmdir) {
      const subdir = abs.replace(/\/index\.md$/, "");
      try { await this.fileIO.rmdir(subdir); } catch { /* still has siblings */ }
    }

    this.invalidateCaches();

    return {
      type,
      id: slug,
      path: rel,
      deadReferences: refResult.references.map(r => ({
        file: r.file,
        line: r.line,
        display: r.display,
      })),
    };
  }

  // ── Schema observation ──

  /**
   * Scan all entities of a type and tally which frontmatter keys appear.
   * Used by `describe_entity_type` to report drift between declared schema
   * and reality.
   */
  async scanObservedFields(type: FileBackedEntityType): Promise<ObservedFields> {
    const cached = this.observedCache.get(type);
    if (cached) return cached;

    const slugs = await this.listSlugsOnDisk(type);
    const tally: Record<string, { count: number; examples: string[] }> = {};

    for (const slug of slugs) {
      try {
        const { abs } = this.pathFor(type, slug);
        const raw = await this.fileIO.readFile(abs);
        const { frontMatter } = parseFrontMatter(raw);
        for (const key of Object.keys(frontMatter)) {
          if (key.startsWith("_")) continue;
          const bucket = tally[key] ?? (tally[key] = { count: 0, examples: [] });
          bucket.count++;
          if (bucket.examples.length < 5) bucket.examples.push(slug);
        }
      } catch {
        // Skip unreadable
      }
    }

    const observed: ObservedFields = {};
    for (const [key, { count, examples }] of Object.entries(tally)) {
      observed[key] = { occursIn: count, examples };
    }
    this.observedCache.set(type, observed);
    return observed;
  }

  /** Schema drift across all types in one shot (handy for `find_schema_drift`). */
  async scanAllObservedFields(): Promise<Record<FileBackedEntityType, ObservedFields>> {
    const out: Partial<Record<FileBackedEntityType, ObservedFields>> = {};
    for (const type of FILE_BACKED_ENTITY_TYPES) {
      out[type] = await this.scanObservedFields(type);
    }
    return out as Record<FileBackedEntityType, ObservedFields>;
  }

  // ── References ──

  /** Find files in the campaign with no inbound wikilinks. */
  async detectOrphans(): Promise<{ type: FileBackedEntityType; id: string; path: string }[]> {
    const tree = await this.scanIndex();
    const walked = await walkCampaignFiles(this.campaignRoot, this.fileIO as Parameters<typeof walkCampaignFiles>[1]);

    // Build inbound count by resolving every link.
    const inbound = new Map<string, number>();
    for (const file of walked) {
      const links = extractWikilinks(file.content);
      for (const link of links) {
        const resolved = resolveRelativePath(file.relativePath, link.target);
        // Don't count self-references as inbound.
        if (resolved === file.relativePath) continue;
        inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1);
      }
    }

    const orphans: { type: FileBackedEntityType; id: string; path: string }[] = [];
    for (const [slug, entry] of Object.entries(tree)) {
      if (!isFileBackedEntityType(entry.type)) continue;
      if ((inbound.get(entry.path) ?? 0) === 0) {
        orphans.push({ type: entry.type, id: slug, path: entry.path });
      }
    }
    return orphans;
  }

  // ── Internals ──

  private parseAliases(raw: unknown): string[] {
    if (typeof raw !== "string" || !raw.trim()) return [];
    return raw.split(",").map(a => a.trim()).filter(Boolean);
  }

  /**
   * Outbound + inbound refs for a single entity. Outbound are resolved to
   * `type:slug` when they land on a known file; dead targets are surfaced
   * as the raw resolved path for diagnostics.
   */
  private async collectReferences(
    type: FileBackedEntityType,
    slug: string,
    rel: string,
    body: string,
  ): Promise<{ outbound: string[]; inbound: string[]; dead: string[] }> {
    const tree = await this.scanIndex();
    const pathToTypeSlug = new Map<string, string>();
    for (const [s, entry] of Object.entries(tree)) {
      pathToTypeSlug.set(entry.path, `${entry.type}:${s}`);
    }

    const outbound: string[] = [];
    const dead: string[] = [];
    for (const link of extractWikilinks(body)) {
      const resolved = resolveRelativePath(rel, link.target);
      const labeled = pathToTypeSlug.get(resolved);
      if (labeled) outbound.push(labeled);
      else dead.push(resolved);
    }

    const refResult = await findReferences(this.campaignRoot, this.fileIO as Parameters<typeof findReferences>[1], rel);
    const inbound: string[] = [];
    for (const ref of refResult.references) {
      // Skip self-references.
      if (ref.file === rel) continue;
      const labeled = pathToTypeSlug.get(ref.file) ?? ref.file;
      inbound.push(labeled);
    }
    // Dedupe both sides — multiple mentions of the same target collapse.
    return {
      outbound: dedupeKeepOrder(outbound),
      inbound: dedupeKeepOrder(inbound),
      dead: dedupeKeepOrder(dead),
    };
  }

  private computeDrift(
    schema: EntitySchema,
    frontMatter: Record<string, unknown>,
  ): { unknownFields: string[]; missingFields: string[] } {
    const declaredFmKeys = new Set<string>();
    for (const [name, field] of Object.entries(schema.fields)) {
      if (field.source === "frontmatter") declaredFmKeys.add(name);
    }
    // `aliases` is sourced from frontmatter under the on-disk key
    // `additional_names`, not the logical name `aliases`. Map it.
    declaredFmKeys.delete("aliases");
    declaredFmKeys.add("additional_names");

    const unknownFields = Object.keys(frontMatter).filter(k => !declaredFmKeys.has(k));
    const missingFields: string[] = [];
    for (const [name, field] of Object.entries(schema.fields)) {
      if (!field.required) continue;
      // displayName is sourced from h1, not frontmatter — checked separately.
      if (field.source === "frontmatter") {
        const key = name === "aliases" ? "additional_names" : name;
        if (!(key in frontMatter)) missingFields.push(name);
      }
    }
    return { unknownFields, missingFields };
  }

  private runValidation(
    schema: EntitySchema,
    displayName: string,
    frontMatter: Record<string, unknown>,
    refs: { dead: string[] },
  ): EntityRecord["validation"] {
    const issues: ValidationIssue[] = [];
    for (const [name, field] of Object.entries(schema.fields)) {
      if (!field.required) continue;
      if (field.source === "h1" && !displayName.trim()) {
        issues.push({ level: "error", field: name, msg: `Missing H1 heading (${name})` });
      }
      if (field.source === "frontmatter") {
        const key = name === "aliases" ? "additional_names" : name;
        if (!(key in frontMatter)) {
          issues.push({ level: "error", field: name, msg: `Missing required field: ${name}` });
        }
      }
    }
    for (const dead of refs.dead) {
      issues.push({ level: "warning", msg: `Outbound wikilink does not resolve: ${dead}` });
    }
    const hasError = issues.some(i => i.level === "error");
    const hasWarn  = issues.some(i => i.level === "warning");
    return {
      status: hasError ? "errors" : hasWarn ? "warnings" : "ok",
      issues,
    };
  }
}

// --- Errors ---

export class EntityNotFoundError extends Error {
  constructor(public type: string, public id: string) {
    super(`Entity not found: ${type}/${id}`);
    this.name = "EntityNotFoundError";
  }
}

export class EntityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityValidationError";
  }
}

// --- Helpers ---

function dedupeKeepOrder<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of arr) {
    if (!seen.has(item)) { seen.add(item); out.push(item); }
  }
  return out;
}
