/**
 * Executable tool input contracts.
 *
 * TypeBox is the schema-authoring layer for new and migrated tools: one schema
 * supplies both the provider-facing JSON Schema and the handler's static input
 * type. Ajv is the runtime boundary because it can also validate the repo's
 * existing plain JSON Schema objects while they are migrated incrementally.
 *
 * The order is deliberate:
 *
 *   raw model input -> allowlisted repair -> structural validation
 *                   -> semantic refinement -> handler
 *
 * A handler never sees rejected input. Repairs and rejections are written to
 * engine.jsonl as one moderately verbose, privacy-safe event per call.
 */
import {
  Ajv,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";
import { logEvent } from "../context/engine-log.js";
import { currentSpan, setSpanAttrs } from "../context/trace.js";
import type {
  NormalizedTool,
  ToolExecutionContext,
} from "../providers/types.js";

export type ToolCriticality =
  | "advisory"
  | "reversible"
  | "durable"
  | "commit"
  | "expensive";

export interface ToolInputIssue {
  /** JSON Pointer into the tool input. Root is "/". */
  path: string;
  /** Stable machine-readable reason. */
  code: string;
  expected: string;
  /** Shape-only summary; never contains free-form argument prose. */
  actual: string;
  /** Human-readable explanation suitable for the model's tool result. */
  message: string;
}

export interface ToolInputRepair {
  path: string;
  /** Stable allowlisted repair name, e.g. "csv_to_string_array". */
  code: string;
  from: string;
  to: string;
  message: string;
}

export interface ToolRepairResult {
  input: unknown;
  repairs?: ToolInputRepair[];
}

export interface ToolInputPolicy<T = Record<string, unknown>> {
  criticality: ToolCriticality;
  /**
   * Deterministic, intent-preserving canonicalization only. Ambiguous or lossy
   * changes belong in a rejection, not here.
   */
  repair?: (input: unknown) => ToolRepairResult;
  /** Domain and cross-field invariants that JSON Schema cannot express. */
  refine?: (input: T) => ToolInputIssue[];
}

export interface ToolContract<S extends TSchema> {
  definition: NormalizedTool;
  policy: ToolInputPolicy<Static<S>>;
  schema: S;
}

export interface ToolContractOptions<S extends TSchema> {
  name: string;
  description: string;
  schema: S;
  criticality: ToolCriticality;
  repair?: (input: unknown) => ToolRepairResult;
  refine?: (input: Static<S>) => ToolInputIssue[];
}

export type ToolInput<S extends TSchema> = Static<S>;

export function defineToolContract<S extends TSchema>(
  options: ToolContractOptions<S>,
): ToolContract<S> {
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
    },
    policy: {
      criticality: options.criticality,
      repair: options.repair,
      refine: options.refine,
    },
    schema: options.schema,
  };
}

export type ToolInputValidation<T> =
  | { ok: true; value: T; repairs: ToolInputRepair[] }
  | ToolInputValidationFailure;

export interface ToolInputValidationFailure {
  ok: false;
  content: string;
  issues: ToolInputIssue[];
  repairs: ToolInputRepair[];
}

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
});

const validatorCache = new WeakMap<object, ValidateFunction>();

function validatorFor(definition: NormalizedTool): ValidateFunction {
  const schema = definition.inputSchema;
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

function pointerEscape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function issuePath(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = String(
      (error.params as { missingProperty?: string }).missingProperty ?? "",
    );
    return `${error.instancePath}/${pointerEscape(missing)}`;
  }
  if (error.keyword === "additionalProperties") {
    const extra = String(
      (error.params as { additionalProperty?: string }).additionalProperty ?? "",
    );
    return `${error.instancePath}/${pointerEscape(extra)}`;
  }
  return error.instancePath || "/";
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (pointer === "/" || pointer === "") return root;
  let value = root;
  for (const encoded of pointer.split("/").slice(1)) {
    if (value === null || typeof value !== "object") return undefined;
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function describeToolInputValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return `string(length=${value.length})`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? "finite number" : "non-finite number";
  }
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === "object") {
    return `object(keys=${Object.keys(value as object).length})`;
  }
  return typeof value;
}

function issueCode(error: ErrorObject, value: unknown): string {
  if (error.keyword === "required") return "required";
  if (error.keyword === "type") return "type";
  if (error.keyword === "enum") return "enum";
  if (error.keyword === "minLength") {
    return typeof value === "string" && value.trim().length === 0
      ? "blank"
      : "min_length";
  }
  if (error.keyword === "maxLength") return "max_length";
  if (error.keyword === "minItems") return "min_items";
  if (error.keyword === "maxItems") return "max_items";
  if (error.keyword === "additionalProperties") return "unknown_field";
  return error.keyword.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function expectedDescription(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return "required property";
    case "type":
      return String(params.type ?? "declared type");
    case "enum": {
      const values = Array.isArray(params.allowedValues)
        ? params.allowedValues.slice(0, 12)
        : [];
      return `one of ${JSON.stringify(values)}`;
    }
    case "minLength":
      return `string length >= ${String(params.limit)}`;
    case "maxLength":
      return `string length <= ${String(params.limit)}`;
    case "minItems":
      return `array length >= ${String(params.limit)}`;
    case "maxItems":
      return `array length <= ${String(params.limit)}`;
    case "additionalProperties":
      return "declared property";
    default:
      return error.message ?? error.keyword;
  }
}

function ajvIssue(error: ErrorObject, input: unknown): ToolInputIssue {
  const path = issuePath(error);
  const value = pointerValue(input, path);
  const expected = expectedDescription(error);
  const actual = describeToolInputValue(value);
  return {
    path,
    code: issueCode(error, value),
    expected,
    actual,
    message: `${path}: expected ${expected}; received ${actual}`,
  };
}

function diagnosticContext(
  context: ToolExecutionContext | undefined,
): Record<string, unknown> {
  const span = currentSpan();
  return {
    ...(context
      ? {
          agent: context.agent,
          provider: context.provider,
          model: context.model,
          callId: context.callId,
        }
      : {}),
    ...(span
      ? {
          campaignId: span.campaignId,
          turnId: span.turnId,
          spanId: span.spanId,
        }
      : {}),
  };
}

function formatFailure(
  definition: NormalizedTool,
  criticality: ToolCriticality,
  issues: ToolInputIssue[],
): string {
  const details = issues
    .slice(0, 8)
    .map((issue) => `- ${issue.message}`)
    .join("\n");
  const remainder = issues.length > 8
    ? `\n- ${issues.length - 8} additional issue(s) omitted`
    : "";
  return (
    `Invalid input for tool "${definition.name}" (${criticality}).\n`
    + `${details}${remainder}\n`
    + "No side effects were applied. Retry the tool call with corrected arguments."
  );
}

export function rejectToolInput(
  definition: NormalizedTool,
  criticality: ToolCriticality,
  issues: ToolInputIssue[],
  context?: ToolExecutionContext,
  repairs: ToolInputRepair[] = [],
): ToolInputValidationFailure {
  const content = formatFailure(definition, criticality, issues);
  logEvent("tool_input:rejected", {
    ...diagnosticContext(context),
    tool: definition.name,
    criticality,
    issueCount: issues.length,
    issues,
    ...(repairs.length ? { repairs } : {}),
    retryable: true,
  });
  setSpanAttrs({
    inputValidation: "rejected",
    inputIssueCount: issues.length,
  });
  return { ok: false, content, issues, repairs };
}

export function validateToolInput<T = Record<string, unknown>>(
  definition: NormalizedTool,
  rawInput: unknown,
  policy: ToolInputPolicy<T> = { criticality: "advisory" },
  context?: ToolExecutionContext,
): ToolInputValidation<T> {
  let candidate = rawInput;
  let repairs: ToolInputRepair[] = [];

  try {
    if (policy.repair) {
      const repaired = policy.repair(rawInput);
      candidate = repaired.input;
      repairs = repaired.repairs ?? [];
    }
  } catch {
    const issue: ToolInputIssue = {
      path: "/",
      code: "repair_failed",
      expected: "repair function to complete",
      actual: describeToolInputValue(rawInput),
      message: "/: the contract's input repair failed",
    };
    return rejectToolInput(
      definition,
      policy.criticality,
      [issue],
      context,
      repairs,
    );
  }

  let structuralIssues: ToolInputIssue[];
  try {
    const validate = validatorFor(definition);
    structuralIssues = validate(candidate)
      ? []
      : (validate.errors ?? []).map((error) => ajvIssue(error, candidate));
  } catch (error) {
    structuralIssues = [{
      path: "/",
      code: "invalid_contract_schema",
      expected: "a compilable JSON Schema",
      actual: "invalid schema",
      message:
        `/: tool contract schema could not be compiled: ${
          error instanceof Error ? error.message : String(error)
        }`,
    }];
  }

  if (structuralIssues.length > 0) {
    return rejectToolInput(
      definition,
      policy.criticality,
      structuralIssues,
      context,
      repairs,
    );
  }

  const value = candidate as T;
  let semanticIssues: ToolInputIssue[];
  try {
    semanticIssues = policy.refine?.(value) ?? [];
  } catch {
    semanticIssues = [{
      path: "/",
      code: "semantic_validation_failed",
      expected: "semantic validation to complete",
      actual: describeToolInputValue(candidate),
      message: "/: the contract's semantic validation failed",
    }];
  }
  if (semanticIssues.length > 0) {
    return rejectToolInput(
      definition,
      policy.criticality,
      semanticIssues,
      context,
      repairs,
    );
  }

  if (repairs.length > 0) {
    logEvent("tool_input:repaired", {
      ...diagnosticContext(context),
      tool: definition.name,
      criticality: policy.criticality,
      repairCount: repairs.length,
      repairs,
    });
    setSpanAttrs({
      inputValidation: "repaired",
      inputRepairCount: repairs.length,
    });
  }

  return { ok: true, value, repairs };
}
