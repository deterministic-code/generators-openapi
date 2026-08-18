/** Pure OpenAPI-document helpers: path predicates, bucket grouping and CRUD/readonly classification, and response/request schema access. No I/O; every helper reads the parsed OpenAPI document and produces deterministic output. Consumed by openapi-crud-helpers.ts (client-live lane) and openapi-spec-build.ts. */
import { resolveRef } from "./schema-sample.ts";
import type {
  Bucket,
  BucketClassification,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiSchema,
} from "./openapi-types.ts";

const VERBS = ["get", "post", "put", "patch", "delete"];

interface ResponseSchemaInfo {
  code: string;
  schema: OpenApiSchema;
}

export function lastSegmentIsParam(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1];
  return last.startsWith("{") && last.endsWith("}");
}

function parentOf(memberPath: string): string {
  const segs = memberPath.split("/").filter(Boolean);
  segs.pop();
  return "/" + segs.join("/");
}

export function hasOp(pathItem: OpenApiPathItem, method: string): boolean {
  return Boolean(pathItem && pathItem[method]);
}

export function methodsOf(pathItem: OpenApiPathItem): string[] {
  return VERBS.filter((v) => hasOp(pathItem, v));
}

function isStub(operation: OpenApiOperation): boolean {
  return Boolean(operation) && operation["x-implementation"] === "stub";
}

export function stripStubOperations(
  paths: Record<string, OpenApiPathItem>,
): Record<string, OpenApiPathItem> {
  const out: Record<string, OpenApiPathItem> = {};
  for (const [p, item] of Object.entries(paths)) {
    const filtered: OpenApiPathItem = {};
    let kept = 0;
    for (const [method, op] of Object.entries(item)) {
      if (VERBS.includes(method) && isStub(op)) continue;
      filtered[method] = op;
      if (VERBS.includes(method)) kept++;
    }
    if (kept > 0) out[p] = filtered;
  }
  return out;
}

export function groupBuckets(paths: Record<string, OpenApiPathItem>): Bucket[] {
  const collections = new Map<string, Bucket>();
  for (const p of Object.keys(paths)) {
    if (!lastSegmentIsParam(p)) {
      collections.set(p, { collectionPath: p, memberPath: null });
    }
  }
  for (const p of Object.keys(paths)) {
    if (lastSegmentIsParam(p)) {
      const parent = parentOf(p);
      const bucket = collections.get(parent);
      if (bucket) {
        bucket.memberPath = p;
      } else {
        collections.set(parent, { collectionPath: parent, memberPath: p });
      }
    }
  }
  return [...collections.values()].sort((a, b) =>
    a.collectionPath.localeCompare(b.collectionPath),
  );
}

export function operationResponseSchema(
  operation: OpenApiOperation,
): ResponseSchemaInfo | null {
  const responses = operation?.responses ?? {};
  const codes = ["200", "201", "default"];
  for (const code of codes) {
    const r = responses[code];
    const sch = r?.content?.["application/json"]?.schema;
    if (sch) return { code, schema: sch };
  }
  for (const code of Object.keys(responses)) {
    const r = responses[code];
    const sch = r?.content?.["application/json"]?.schema;
    if (sch) return { code, schema: sch };
  }
  return null;
}

export function operationRequestSchema(
  operation: OpenApiOperation,
): OpenApiSchema | null {
  return operation?.requestBody?.content?.["application/json"]?.schema ?? null;
}

function isCollectionResponseSchema(
  schema: OpenApiSchema,
  doc: OpenApiDocument,
): boolean {
  if (!schema || typeof schema !== "object") return false;
  const resolved = schema.$ref ? resolveRef(schema.$ref, doc) : schema;
  if (!resolved || typeof resolved !== "object") return false;
  if (resolved.type === "array") return true;
  const items = resolved.properties?.items;
  if (items && typeof items === "object") {
    if (items.type === "array") return true;
    const itemsResolved = items.$ref ? resolveRef(items.$ref, doc) : items;
    if (itemsResolved?.type === "array") return true;
  }
  return false;
}

function classifyReadonlyKind(
  collectionItem: OpenApiPathItem,
  doc: OpenApiDocument,
): "readonly" | "readonly-singleton" {
  const respInfo = operationResponseSchema(collectionItem.get);
  const isCollection = respInfo
    ? isCollectionResponseSchema(respInfo.schema, doc)
    : false;
  return isCollection ? "readonly" : "readonly-singleton";
}

function crudVerb(
  bucket: Bucket,
  collectionItem: OpenApiPathItem,
  memberItem: OpenApiPathItem,
): "put" | "patch" | null {
  const hasCreate = hasOp(collectionItem, "post");
  const hasMemberRead = hasOp(memberItem, "get");
  const hasMemberDelete = hasOp(memberItem, "delete");
  const hasMemberUpdate =
    hasOp(memberItem, "put") || hasOp(memberItem, "patch");
  if (
    bucket.memberPath &&
    hasCreate &&
    hasMemberRead &&
    hasMemberDelete &&
    hasMemberUpdate
  ) {
    return hasOp(memberItem, "put") ? "put" : "patch";
  }
  return null;
}

export function classifyBucket(
  bucket: Bucket,
  paths: Record<string, OpenApiPathItem>,
  doc: OpenApiDocument,
): BucketClassification {
  const collectionItem: OpenApiPathItem = paths[bucket.collectionPath] ?? {};
  const memberItem: OpenApiPathItem = bucket.memberPath
    ? (paths[bucket.memberPath] ?? {})
    : {};
  const allMethods = new Set([
    ...methodsOf(collectionItem),
    ...methodsOf(memberItem),
  ]);
  const onlyGet = [...allMethods].every((m) => m === "get");
  if (onlyGet && hasOp(collectionItem, "get")) {
    const kind = classifyReadonlyKind(collectionItem, doc);
    return { kind, collectionItem, memberItem };
  }
  const updateVerb = crudVerb(bucket, collectionItem, memberItem);
  if (updateVerb) {
    return { kind: "crud", collectionItem, memberItem, updateVerb };
  }
  return { kind: "other", collectionItem, memberItem };
}
