import { toCase, type CaseFormat } from "./case.ts";

interface OpenApiDoc {
  components?: { schemas?: Record<string, unknown> };
}

const PREFIX = "#/components/schemas/";

function rewriteRefs(node: unknown, rename: Map<string, string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) rewriteRefs(x, rename);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith(PREFIX)) {
      const next = rename.get(v.slice(PREFIX.length));
      if (next) obj[k] = PREFIX + next;
    } else {
      rewriteRefs(v, rename);
    }
  }
}

export function applySchemaNaming(
  doc: OpenApiDoc,
  format: CaseFormat,
): OpenApiDoc {
  if (format === "Snake") return doc;
  const components = doc.components;
  if (!components?.schemas) return doc;
  const schemas = components.schemas;

  const rename = new Map<string, string>();
  for (const k of Object.keys(schemas)) rename.set(k, toCase(k, format));

  const seen = new Map<string, string>();
  for (const [oldK, newK] of rename) {
    if (seen.has(newK)) {
      throw new Error(
        `--schema-naming=${format} produces a collision: '${seen.get(newK)}' and '${oldK}' both map to '${newK}'.`,
      );
    }
    seen.set(newK, oldK);
  }

  const renamed: Record<string, unknown> = {};
  for (const [oldK, newK] of rename) renamed[newK] = schemas[oldK];
  components.schemas = renamed;

  rewriteRefs(doc, rename);
  return doc;
}
