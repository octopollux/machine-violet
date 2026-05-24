/**
 * Agent-facing tools for the entity store.
 *
 * Two layers:
 *  - Tool definitions (NormalizedTool[]) — the JSON-schema-shaped tool surface
 *    that agents see in their tool list.
 *  - Tool handler (dispatchEntityTool) — given a store, runs the requested op
 *    and returns a {content, is_error} payload.
 *
 * Both are stateless w.r.t. session — agents register a single store per
 * session and the handler closes over it.
 */

import type { NormalizedTool } from "../providers/types.js";
import type { ToolResult } from "../agents/tool-registry.js";
import {
  EntityStore,
  EntityNotFoundError,
  EntityValidationError,
  type EntityPatch,
} from "./store.js";
import {
  FILE_BACKED_ENTITY_TYPES,
  getEntitySchema,
  isFileBackedEntityType,
  type FileBackedEntityType,
} from "@machine-violet/shared/schemas/entities/index.js";

// --- Tool name list (single source of truth) ---

export const ENTITY_TOOL_NAMES = [
  "entity",
  "describe_entity_type",
  "list_entity_types",
  "validate_entity",
  "find_schema_drift",
  "detect_orphans",
] as const;

export type EntityToolName = (typeof ENTITY_TOOL_NAMES)[number];

export const ENTITY_TOOL_NAME_SET: ReadonlySet<string> = new Set(ENTITY_TOOL_NAMES);

// --- Tool definitions ---

const TYPE_ENUM = FILE_BACKED_ENTITY_TYPES as readonly string[];

export const ENTITY_TOOLS: NormalizedTool[] = [
  {
    name: "entity",
    description:
      "CRUD on file-backed entities — characters, locations, factions, lore, items. " +
      "Replaces direct file editing for entity work. " +
      "Operations: read | create | update | delete | list. " +
      "`read` returns the full record (frontmatter + body + refs + schema + drift) — verbose by design so you learn the data shape. " +
      "`update` patch values of null delete a frontmatter key. " +
      "`delete` removes the file and reports inbound wikilinks that just became dead. " +
      "For map placement, use map_entity instead. For narrative writes, use scribe.",
    inputSchema: {
      type: "object" as const,
      properties: {
        op: { type: "string", enum: ["read", "create", "update", "delete", "list"] },
        type: { type: "string", enum: [...TYPE_ENUM] },
        id: { type: "string", description: "Entity slug or display name. Required for read/update/delete." },
        patch: {
          type: "object",
          description: "For create/update. Shape: { displayName?, frontMatter?, body?, changelogEntry? }. On update, frontMatter values of null delete the key.",
          properties: {
            displayName: { type: "string" },
            frontMatter: { type: "object" },
            body: { type: "string" },
            changelogEntry: { type: "string" },
          },
        },
      },
      required: ["op", "type"],
    },
  },
  {
    name: "describe_entity_type",
    description:
      "Describe the data shape of a file-backed entity type: declared schema, observed drift, storage layout, conventions, examples. " +
      "Call this when you want to learn what fields an entity supports or what people actually put in it — declared schema is canonical; observed-drift fields are real data that haven't been formally adopted yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: [...TYPE_ENUM] },
      },
      required: ["type"],
    },
  },
  {
    name: "list_entity_types",
    description:
      "List all file-backed entity types with their on-disk counts. Cheap inventory pass — use this before describe_entity_type to see what's available.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "validate_entity",
    description:
      "Validate a single entity: missing required fields, dead outbound wikilinks, schema conformance. Returns the validation block from the entity record.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: [...TYPE_ENUM] },
        id: { type: "string" },
      },
      required: ["type", "id"],
    },
  },
  {
    name: "find_schema_drift",
    description:
      "List frontmatter fields present on disk but not in the declared schema. Optionally scope to a single entity type.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: [...TYPE_ENUM], description: "Optional. Omit to scan all types." },
      },
      required: [],
    },
  },
  {
    name: "detect_orphans",
    description:
      "List file-backed entities with zero inbound wikilinks across the campaign. Useful for spotting forgotten characters or locations that nothing references.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Handler ---

/** Whether to expose the dev-only raw escape hatch. */
export interface EntityToolHandlerOptions {
  /** Current scene number to weave into changelog entries (defaults to 0). */
  sceneNumber?: number;
}

/**
 * Build an async handler that dispatches the entity tool surface against
 * a store. Returns `null` when the tool isn't ours (caller falls through).
 */
export function buildEntityToolHandler(
  store: EntityStore,
  options: EntityToolHandlerOptions = {},
): (name: string, input: Record<string, unknown>) => Promise<ToolResult | null> {
  return async (name, input) => {
    if (!ENTITY_TOOL_NAME_SET.has(name)) return null;
    try {
      switch (name as EntityToolName) {
        case "entity":              return await handleEntity(store, input, options.sceneNumber ?? 0);
        case "describe_entity_type": return await handleDescribe(store, input);
        case "list_entity_types":   return await handleListTypes(store);
        case "validate_entity":     return await handleValidate(store, input);
        case "find_schema_drift":   return await handleFindDrift(store, input);
        case "detect_orphans":      return await handleDetectOrphans(store);
      }
    } catch (e) {
      if (e instanceof EntityNotFoundError || e instanceof EntityValidationError) {
        return { content: e.message, is_error: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `${name} failed: ${msg}`, is_error: true };
    }
  };
}

// --- Individual handlers ---

async function handleEntity(
  store: EntityStore,
  input: Record<string, unknown>,
  sceneNumber: number,
): Promise<ToolResult> {
  const op = input.op as string;
  const type = input.type as string;
  if (!isFileBackedEntityType(type)) {
    return { content: `Unknown entity type: ${type}. Try one of ${FILE_BACKED_ENTITY_TYPES.join(", ")}.`, is_error: true };
  }

  switch (op) {
    case "read": {
      const id = input.id as string | undefined;
      if (!id) return { content: "read requires `id`", is_error: true };
      const rec = await store.read(type, id);
      return { content: JSON.stringify(rec, null, 2) };
    }

    case "list": {
      const list = await store.list(type);
      return { content: JSON.stringify(list, null, 2) };
    }

    case "create": {
      const patch = (input.patch as EntityPatch | undefined) ?? {};
      if (!patch.displayName?.trim()) {
        return { content: "create requires patch.displayName", is_error: true };
      }
      const rec = await store.create(type, patch, sceneNumber);
      return { content: JSON.stringify(rec, null, 2) };
    }

    case "update": {
      const id = input.id as string | undefined;
      if (!id) return { content: "update requires `id`", is_error: true };
      const patch = (input.patch as EntityPatch | undefined) ?? {};
      const rec = await store.update(type, id, patch, sceneNumber);
      return { content: JSON.stringify(rec, null, 2) };
    }

    case "delete": {
      const id = input.id as string | undefined;
      if (!id) return { content: "delete requires `id`", is_error: true };
      const result = await store.delete(type, id);
      return { content: JSON.stringify(result, null, 2) };
    }

    default:
      return { content: `Unknown op: ${op}. Use read | create | update | delete | list.`, is_error: true };
  }
}

async function handleDescribe(
  store: EntityStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const type = input.type as string;
  if (!isFileBackedEntityType(type)) {
    return { content: `Unknown entity type: ${type}.`, is_error: true };
  }
  const schema = getEntitySchema(type);
  const observed = await store.scanObservedFields(type);
  const list = await store.list(type);
  const examples = list.slice(0, 3).map(e => e.path);

  const declaredFmKeys = new Set<string>();
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.source === "frontmatter") {
      declaredFmKeys.add(name);
    }
  }
  const observedDrift: Record<string, { occursIn: number; examples: string[] }> = {};
  for (const [k, v] of Object.entries(observed)) {
    if (!declaredFmKeys.has(k)) observedDrift[k] = v;
  }

  const out = {
    type,
    schemaVersion: schema.version,
    storage: schema.storage,
    fields: schema.fields,
    observedDrift,
    conventions: schema.conventions,
    examples,
  };
  return { content: JSON.stringify(out, null, 2) };
}

async function handleListTypes(store: EntityStore): Promise<ToolResult> {
  const result: { type: FileBackedEntityType; count: number; dir: string }[] = [];
  for (const type of FILE_BACKED_ENTITY_TYPES) {
    const list = await store.list(type);
    result.push({ type, count: list.length, dir: getEntitySchema(type).storage.dir });
  }
  return { content: JSON.stringify(result, null, 2) };
}

async function handleValidate(
  store: EntityStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const type = input.type as string;
  const id = input.id as string;
  if (!isFileBackedEntityType(type)) {
    return { content: `Unknown entity type: ${type}.`, is_error: true };
  }
  if (!id) return { content: "validate_entity requires `id`", is_error: true };
  const rec = await store.read(type, id);
  return {
    content: JSON.stringify({
      type: rec.type,
      id: rec.id,
      validation: rec.validation,
      drift: rec.drift,
      references: rec.references,
    }, null, 2),
  };
}

async function handleFindDrift(
  store: EntityStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const type = input.type as string | undefined;
  const types: FileBackedEntityType[] = type && isFileBackedEntityType(type)
    ? [type]
    : [...FILE_BACKED_ENTITY_TYPES];

  const out: Record<string, Record<string, { occursIn: number; examples: string[] }>> = {};
  for (const t of types) {
    const observed = await store.scanObservedFields(t);
    const schema = getEntitySchema(t);
    const declaredFmKeys = new Set<string>();
    for (const [name, field] of Object.entries(schema.fields)) {
      if (field.source === "frontmatter") {
        declaredFmKeys.add(name);
      }
    }
    const drift: Record<string, { occursIn: number; examples: string[] }> = {};
    for (const [k, v] of Object.entries(observed)) {
      if (!declaredFmKeys.has(k)) drift[k] = v;
    }
    out[t] = drift;
  }
  return { content: JSON.stringify(out, null, 2) };
}

async function handleDetectOrphans(store: EntityStore): Promise<ToolResult> {
  const orphans = await store.detectOrphans();
  return { content: JSON.stringify(orphans, null, 2) };
}

// --- Dev-only raw escape hatch ---

/**
 * Raw byte-level entity I/O. Dev-only. Mirrors the old read_file/write_file/
 * delete_file shape but explicitly named so it stands out in transcripts —
 * if you see `raw_entity_io` in a turn, it means the agent bypassed the
 * structured surface, which is almost always wrong outside debugging.
 */
export const RAW_ENTITY_IO_TOOL: NormalizedTool = {
  name: "raw_entity_io",
  description:
    "DEV-ONLY. Raw byte-level read/write/delete on an entity file path. " +
    "Bypasses schema validation and the wikilink-aware delete sweep. " +
    "Prefer `entity` for everything except recovery from a corrupted file.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Path relative to the campaign root, e.g. characters/arvid.md" },
      op: { type: "string", enum: ["read", "write", "delete"] },
      body: { type: "string", description: "Required for write." },
    },
    required: ["path", "op"],
  },
};
