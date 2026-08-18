// Schema-shape helpers shared across the OpenAPI generators (request-body samples, response fixtures, and stub-service return values) so every consumer derives byte-equivalent shapes from one source.

import type { OpenApiSchema, OpenApiDocument } from "./openapi-types.ts";
import { FieldConverter, fieldConverter } from "../../../field-converter.ts";
import { converterTypeForSchema } from "../../lib/schema-build.ts";

const TS = new FieldConverter(fieldConverter);

type RefSchema = OpenApiSchema & { $ref: string };

interface ExprCtx {
  doc: OpenApiDocument;
  iterExpr: string;
  prefix: string;
  capturedExpr?: Record<string, string> | null;
  seen: Set<string>;
}

type ExprCtxInput = Omit<ExprCtx, "seen"> & { seen?: Set<string> };

interface SampleCtx {
  doc: OpenApiDocument;
  index: number;
  seen: Set<string>;
}

export function resolveRef(
  ref: unknown,
  doc: OpenApiDocument,
): OpenApiSchema | null {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let node: unknown = doc;
  for (const p of parts) {
    if (node == null) return null;
    node = (node as Record<string, unknown>)[p];
  }
  return (node as OpenApiSchema | null) ?? null;
}

function jsStringLiteral(value: unknown): string {
  return JSON.stringify(value);
}

/** The `(key, prop)` pairs for a schema's `required` list, in declared order — `prop` is `undefined` when a required key has no entry under `properties`. */
function requiredProps(
  schema: OpenApiSchema,
): Array<[string, OpenApiSchema | undefined]> {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties ?? {};
  return required.map((key) => [key, props[key]]);
}

function stringValueExpr(schema: OpenApiSchema, ctx: ExprCtx): string {
  const { iterExpr, prefix } = ctx;
  const key = converterTypeForSchema(schema);
  if (key === "datetime" || key === "date" || key === "binary")
    return TS.jsonSample({ type: key });
  if (key === "uuid")
    return TS.generatedSample({ type: "uuid" }, { unique: true });
  if (key === "email")
    return `\`${prefix}-\${${iterExpr}}-\${randSuffix()}@example.com\``;
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maxLength =
    typeof schema.maxLength === "number" ? schema.maxLength : null;
  if (maxLength !== null) {
    // Unique token FIRST so slicing a prefix longer than maxLength can't collapse distinct seeds to the same value — the FK-path prefix routinely exceeds maxLength and would 409 a unique column otherwise.
    return `(\`\${${iterExpr}}-\${randSuffix()}-${prefix}\`).slice(0, ${maxLength})`;
  }
  const baseExpr = `\`${prefix}-\${${iterExpr}}-\${randSuffix()}\``;
  if (minLength > 0) return `(${baseExpr}).padEnd(${minLength}, "x")`;
  return baseExpr;
}

function refValueExpr(schema: RefSchema, ctx: ExprCtx): string {
  if (ctx.seen.has(schema.$ref)) return "null";
  const seen = new Set(ctx.seen);
  seen.add(schema.$ref);
  return valueExpr(resolveRef(schema.$ref, ctx.doc), { ...ctx, seen });
}

function arrayValueExpr(schema: OpenApiSchema, ctx: ExprCtx): string {
  const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
  if (minItems <= 0) return "[]";
  return `[${valueExpr(schema.items, { ...ctx, capturedExpr: null })}]`;
}

function objectValueExpr(schema: OpenApiSchema, ctx: ExprCtx): string {
  const parts: string[] = [];
  for (const [key, prop] of requiredProps(schema)) {
    if (!prop || prop.readOnly) continue;
    const subExpr =
      ctx.capturedExpr && ctx.capturedExpr[key]
        ? ctx.capturedExpr[key]
        : valueExpr(prop, { ...ctx, capturedExpr: null });
    parts.push(`${jsStringLiteral(key)}: ${subExpr}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function valueExpr(
  schema: OpenApiSchema | null | undefined,
  ctx: ExprCtx,
): string {
  if (!schema) return "null";
  if (schema.$ref) return refValueExpr(schema as RefSchema, ctx);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return jsStringLiteral(schema.enum[0]);
  }
  if (schema.type === "array") return arrayValueExpr(schema, ctx);
  if (schema.type === "object" || schema.properties) {
    return objectValueExpr(schema, ctx);
  }
  if (schema.type === "boolean") return "false";
  if (schema.type === "integer" || schema.type === "number") {
    return `(${ctx.iterExpr} + 1)`;
  }
  if (schema.type === "string" || schema.type === undefined) {
    return stringValueExpr(schema, ctx);
  }
  return "null";
}

/** Returns a JS source expression (string) that evaluates at runtime to a sample value of `schema`. `ctx`: `{ doc, iterExpr, prefix, capturedExpr }` — `iterExpr` is the current-iteration index expression (e.g. "i"), `prefix` keeps generated strings distinguishable, `capturedExpr` wires previously-captured ids (e.g. FK fields) into the expression. */
export function valueAsJsExpr(
  schema: OpenApiSchema | null | undefined,
  ctx: ExprCtxInput,
): string {
  return valueExpr(schema, { ...ctx, seen: ctx.seen ?? new Set() });
}

function sampleString(schema: OpenApiSchema, index: number): unknown {
  return TS.rawSample(converterTypeForSchema(schema), index, {
    maxLength:
      typeof schema.maxLength === "number" ? schema.maxLength : undefined,
    minLength:
      typeof schema.minLength === "number" ? schema.minLength : undefined,
  });
}

function sampleArray(schema: OpenApiSchema, ctx: SampleCtx): unknown[] {
  const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
  if (minItems > 0) return [sampleNode(schema.items, ctx)];
  return [];
}

function sampleObject(
  schema: OpenApiSchema,
  ctx: SampleCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of requiredProps(schema)) {
    if (!prop) continue;
    if (prop.readOnly) continue;
    out[key] = sampleNode(prop, ctx);
  }
  return out;
}

function sampleRef(schema: RefSchema, ctx: SampleCtx): unknown {
  if (ctx.seen.has(schema.$ref)) return null;
  const next = new Set(ctx.seen);
  next.add(schema.$ref);
  return sampleNode(resolveRef(schema.$ref, ctx.doc), { ...ctx, seen: next });
}

function sampleNode(
  schema: OpenApiSchema | null | undefined,
  ctx: SampleCtx,
): unknown {
  if (!schema) return null;
  if (schema.$ref) return sampleRef(schema as RefSchema, ctx);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.type === "array") return sampleArray(schema, ctx);
  if (schema.type === "object" || schema.properties) {
    return sampleObject(schema, ctx);
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") {
    return ctx.index + 1;
  }
  if (schema.type === "string" || schema.type === undefined) {
    return sampleString(schema, ctx.index);
  }
  return null;
}

/** Returns a plain JS value (not source) that conforms to `schema`. Used to materialize sample bodies at codegen time so they can be embedded as JSON literals in generated test files / stub service returns. */
export function sampleFromSchema(
  schema: OpenApiSchema | null | undefined,
  doc: OpenApiDocument,
  index: number,
): unknown {
  return sampleNode(schema, { doc, index, seen: new Set() });
}
