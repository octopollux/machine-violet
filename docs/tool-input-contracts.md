# Tool Input Contracts

Tool declarations are executable engine contracts, not provider hints. Models
may omit required fields, send the wrong JSON shape, or produce structurally
valid but semantically corrupted arguments even when a provider offers strict
tool schemas. Machine Violet therefore validates every tool call inside the
engine before any handler or persistence callback runs.

## Boundary and ordering

The shared implementation is
`packages/engine/src/agents/tool-contract.ts`. Both surfaced tool calls and
provider-owned in-band calls pass through the same pipeline in
`providers/agent-loop-bridge.ts`:

```text
raw model input
  → allowlisted, deterministic repair
  → structural JSON Schema validation
  → semantic/cross-field refinement
  → handler
  → persistence and success callbacks
```

`ToolRegistry.dispatch()` applies the same validator when it is called
directly. Setup tools do not use the registry, so
`agents/subagents/setup-conversation.ts` applies the shared validator at its
own dispatch chokepoint. A rejected call returns an error tool result that asks
the model to retry; handlers and their side effects are never invoked.

Provider-side `strict` settings are deliberately not part of this guarantee.
They can improve model output, but engine correctness must not vary by
provider.

## Schema authoring

New and migrated tools use TypeBox through `defineToolContract()`. The exact
same schema object becomes:

- the JSON Schema sent to providers;
- the Ajv runtime validator;
- the source of the handler's inferred TypeScript input type.

The registry can also execute existing plain JSON Schema definitions, so tools
can migrate incrementally without losing boundary validation. Do not add a
second hand-maintained runtime schema beside `inputSchema`.

```ts
const CONTRACT = defineToolContract({
  name: "set_example",
  description: "Persist an example.",
  criticality: "durable",
  schema: Type.Object({
    name: Type.String({ minLength: 1 }),
    tags: Type.Array(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  refine: (input) => /* cross-field issues */ [],
});
```

## Criticality and repair policy

Every registry tool must have an entry in `TOOL_CRITICALITY`. Mixed
read/write tools use their most consequential operation. Bespoke tool surfaces
(setup, OOC, resolve sessions, specialist subagents, and DM image tools) pass
the same explicit policies through `toolInputPolicies`.

| Class | Meaning | Default posture |
|---|---|---|
| `advisory` | Read-only or informational | Repair harmless representation slips; reject ambiguous intent |
| `reversible` | Transient UI/session change | Permit narrow canonicalization; reject changed meaning |
| `durable` | Mutates persisted or reloadable state | Bias toward rejection unless the repair is uniquely determined |
| `commit` | Establishes a boundary or replaces authoritative state | Require complete, unambiguous input |
| `expensive` | Starts model, search, or image work | Reject before spending when required input is invalid |

Criticality records the consequence and makes the decision reviewable; it does
not enable ambient coercion. A repair belongs to one contract and must be:

1. deterministic;
2. intent-preserving;
3. allowlisted by a stable repair code;
4. followed by full structural and semantic validation.

For example, `set_display_resources.resources` accepts `"HP, Spell Slots"` as
`["HP", "Spell Slots"]` because that representation is unambiguous in this
specific domain. Converting a scalar into an array is not a global rule. A
missing character name, unknown enum, contradictory parallel arrays, multiple
competing commit calls, or schema text embedded in a semantic field is
rejected.

Defaults are valid only when omission has documented meaning. Do not use
fallbacks to invent required identity, handoff, or persistence values.

## Failure results and diagnostics

Validation errors include the tool name, criticality, JSON Pointer paths,
expected shape, received shape, and the explicit guarantee that no side
effects were applied. They are intentionally detailed enough for a weak
tool-calling model to repair its next call.

The engine also emits one structured event to `.debug/engine.jsonl`:

- `tool_input:repaired` — tool, criticality, call context, repair count, and
  stable repair records;
- `tool_input:rejected` — tool, criticality, call context, issue count,
  retryability, and all validation issues.

Call context includes agent, provider, model, and call ID when available, plus
the current campaign/turn/span IDs. Diagnostics record types, lengths, and
object key counts, never raw free-form tool arguments. The current trace span
gets only summary attributes (`inputValidation`, issue/repair count) rather
than a duplicate event payload.

## Required tests

Changes to tool contracts must keep these layers covered:

1. Contract unit tests: valid input, each permitted repair, structural
   rejection, semantic rejection, and privacy-safe log payloads.
2. Registry audit: the registered tool set and `TOOL_CRITICALITY` must match
   exactly, and every declared schema must compile.
3. Side-effect guard: invalid durable/commit input must not mutate state or
   invoke persistence/success callbacks.
4. Loop recovery: a malformed tool call must return an actionable error to the
   model; one corrected retry must execute exactly once.
5. Domain regression: pin the real failure class, especially omitted required
   scalars, scalar-for-array substitutions, malformed semantic strings,
   contradictory arrays, and duplicate commit calls.

Co-locate these tests with the contract or dispatch path. The main coverage is
in `tool-contract.test.ts`, `tool-registry.test.ts`,
`agent-loop-bridge.test.ts`, and `subagents/setup-conversation.test.ts`.

## Adding or changing a tool

Follow the checklist in [maintenance.md](maintenance.md). In particular,
choose criticality before implementing repairs, keep schema and handler type
derived from one source for new tools, and update this document when the
policy or validation pipeline changes.
