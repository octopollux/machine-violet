/** Stable, collection-independent campaign memory tools. */
import { Type } from "@sinclair/typebox";
import type { KnowledgeOperation } from "@machine-violet/shared/types/knowledge.js";
import type { CampaignKnowledgeStore } from "../knowledge/store.js";
import { defineToolContract, validateToolInput, type ToolInputPolicy } from "../agents/tool-contract.js";
import type { ToolResult } from "../agents/tool-registry.js";
import type { EntityStore } from "./store.js";

const Value = Type.Recursive((Self) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(Self), Type.Record(Type.String(), Self),
]), { $id: "CampaignKnowledgeValue" });
const Fields = Type.Record(Type.String(), Type.Ref(Value));
const Handle = Type.String({ minLength: 1 });
const Edits = {
  name: Type.Optional(Handle), aliases: Type.Optional(Type.Array(Handle)), fields: Type.Optional(Fields),
  body: Type.Optional(Type.String()), visibility: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("player-facing")])),
  history: Type.Optional(Type.String()),
};
const Operation = Type.Union([
  Type.Object({ op: Type.Literal("create_collection"), parent: Type.Optional(Handle), name: Handle, note: Type.Optional(Type.String()) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("upsert"), collection: Handle, uid: Type.Optional(Handle), ...Edits }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("patch"), uid: Handle, ...Edits }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("remove_fields"), uid: Handle, keys: Type.Array(Handle, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("move"), uid: Handle, parent: Handle, index: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("consolidate"), uid: Handle, target: Handle }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("delete"), uid: Handle }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("append_text"), uid: Handle, text: Type.String() }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("append_log"), uid: Handle, body: Type.String(), metadata: Type.Optional(Fields) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("create_node"), parent: Handle, name: Type.Optional(Handle), value: Type.Ref(Value), index: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("set_value"), uid: Handle, value: Type.Ref(Value) }, { additionalProperties: false }),
  Type.Object({ op: Type.Union([Type.Literal("add_reference"), Type.Literal("remove_reference")]), source: Handle, target: Handle, label: Type.Optional(Type.String()) }, { additionalProperties: false }),
]);

export const KNOWLEDGE_CONTRACT = defineToolContract({
  name: "knowledge", criticality: "advisory",
  description: "Inspect campaign memory. outline includes all collections, including empty nested collections and conventions. read accepts a stable UID or known name/alias, with bounded text and history. search checks every collection.",
  schema: Type.Object({
    action: Type.Union([Type.Literal("outline"), Type.Literal("read"), Type.Literal("search")]),
    handle: Type.Optional(Handle), query: Type.Optional(Type.String()),
    textOffset: Type.Optional(Type.Integer({ minimum: 0 })), textLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 16000 })),
    logOffset: Type.Optional(Type.Integer({ minimum: 0 })), logLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    childOffset: Type.Optional(Type.Integer({ minimum: 0 })), childLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    logEntryId: Type.Optional(Type.Integer({ minimum: 1 })),
    logTextOffset: Type.Optional(Type.Integer({ minimum: 0 })), logTextLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 16000 })),
  }, { additionalProperties: false }),
  refine: (input) => input.action === "read" && !input.handle
    ? [{ path: "/handle", code: "required", expected: "UID or name", actual: "absent", message: "read requires handle" }]
    : input.action === "search" && !input.query
      ? [{ path: "/query", code: "required", expected: "search text", actual: "absent", message: "search requires query" }] : [],
});
export const REMEMBER_CONTRACT = defineToolContract({
  name: "remember", criticality: "durable",
  description: "Commit campaign memory changes atomically. Resolve UIDs/names/aliases before creating; same names resolve deterministically. Partial fields preserve unrelated values and references; remove_fields explicitly deletes fields. Collections may be nested with brief conventions. Use explicit references and update current facts with history in one batch. Returns canonical UIDs and potential impact candidates; interpret consequences yourself. Never author SQL or database schemas.",
  schema: Type.Object({ operations: Type.Array(Operation, { minItems: 1, maxItems: 100 }), operationId: Type.Optional(Handle) }, { additionalProperties: false, $defs: { CampaignKnowledgeValue: Value } }),
  refine: (input) => input.operations.flatMap((op, index) => op.op === "upsert" && !op.uid && !op.name
    ? [{ path: `/operations/${index}/name`, code: "required", expected: "name or UID", actual: "absent", message: "upsert requires name or uid" }] : []),
});
export const ENTITY_CONTRACTS = [KNOWLEDGE_CONTRACT, REMEMBER_CONTRACT];
export const ENTITY_TOOLS = ENTITY_CONTRACTS.map((contract) => contract.definition);
export const ENTITY_TOOL_NAME_SET: ReadonlySet<string> = new Set(ENTITY_TOOLS.map((tool) => tool.name));
export const ENTITY_INPUT_POLICIES: Readonly<Record<string, ToolInputPolicy>> = Object.fromEntries(ENTITY_CONTRACTS.map((contract) => [contract.definition.name, contract.policy as ToolInputPolicy]));
export interface EntityToolHandlerOptions { sceneNumber?: number | (() => number); source?: string }

export function buildKnowledgeToolHandler(store: CampaignKnowledgeStore, options: EntityToolHandlerOptions = {}) {
  return async (name: string, input: Record<string, unknown>): Promise<ToolResult | null> => {
    const contract = ENTITY_CONTRACTS.find((candidate) => candidate.definition.name === name);
    if (!contract) return null;
    const validation = validateToolInput(contract.definition, input, contract.policy as ToolInputPolicy);
    if (!validation.ok) return { content: validation.content, is_error: true };
    try {
      if (name === "remember") {
        const sceneNumber = typeof options.sceneNumber === "function" ? options.sceneNumber() : options.sceneNumber;
        return { content: JSON.stringify(await store.mutate(input.operations as KnowledgeOperation[], { sceneNumber, source: options.source ?? "agent", operationId: input.operationId as string | undefined })) };
      }
      if (input.action === "outline") return { content: JSON.stringify(await store.outline()) };
      if (input.action === "read") return { content: JSON.stringify(await store.read(input.handle as string, {
        textOffset: input.textOffset as number | undefined, textLimit: (input.textLimit as number | undefined) ?? 4000,
        logOffset: input.logOffset as number | undefined, logLimit: (input.logLimit as number | undefined) ?? 10,
        childOffset: input.childOffset as number | undefined, childLimit: input.childLimit as number | undefined,
        logEntryId: input.logEntryId as number | undefined,
        logTextOffset: input.logTextOffset as number | undefined, logTextLimit: input.logTextLimit as number | undefined,
      })) };
      const query = (input.query as string).toLocaleLowerCase();
      const hits = [];
      const outline = await store.outline();
      const byUid = new Map(outline.map((entry) => [entry.uid, entry]));
      for (const entry of outline) {
        const node = await store.read(entry.uid, { textLimit: 0, logLimit: 0 });
        let matched = JSON.stringify({ name: node.name, aliases: node.aliases, fields: node.fields, value: node.value, note: node.note }).toLocaleLowerCase().includes(query);
        for (let offset = 0; !matched && offset < node.textLength; offset += 4000) {
          const page = await store.read(node.uid, { textOffset: offset, textLimit: 4000 + query.length, logLimit: 0 });
          matched = String(page.value ?? page.body).toLocaleLowerCase().includes(query);
        }
        for (let offset = 0; !matched && offset < node.logCount; offset += 50) {
          const page = await store.read(node.uid, { textLimit: 0, logOffset: offset, logLimit: 50 });
          matched = JSON.stringify(page.logs).toLocaleLowerCase().includes(query);
          for (const log of page.logs) {
            for (let textOffset = 0; !matched && textOffset < (log.textLength ?? log.body.length); textOffset += 4000) {
              const tail = await store.read(node.uid, { textLimit: 0, logEntryId: log.id, logTextOffset: textOffset, logTextLimit: Math.min(16000, 4000 + query.length) });
              matched = JSON.stringify(tail.logs).toLocaleLowerCase().includes(query);
            }
          }
        }
        if (matched) {
          let owner = byUid.get(node.parent ?? "");
          while (owner?.kind === "value") owner = byUid.get(owner.parent ?? "");
          hits.push({ uid: node.uid, name: node.name, parent: node.parent, kind: node.kind, ...(owner ? { owner: { uid: owner.uid, name: owner.name } } : {}) });
        }
      }
      return { content: JSON.stringify(hits) };
    } catch (error) { return { content: error instanceof Error ? error.message : String(error), is_error: true }; }
  };
}
export function buildEntityToolHandler(store: EntityStore, options: EntityToolHandlerOptions = {}) {
  return async (name: string, input: Record<string, unknown>) => {
    if (!ENTITY_TOOL_NAME_SET.has(name)) return null;
    return buildKnowledgeToolHandler(await store.knowledge(), options)(name, input);
  };
}
/** Removed byte-level bypass, retained only until Dev's tool list is rebuilt. */
export const RAW_ENTITY_IO_TOOL = {
  name: "raw_entity_io", description: "Removed. Use knowledge and remember for campaign memory.",
  inputSchema: Type.Object({ path: Handle, op: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("delete")]), body: Type.Optional(Type.String()) }),
};
