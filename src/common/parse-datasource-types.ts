import { parse } from "yaml";
import { referenceFieldShape } from "./datasource-settings.ts";
import { isRecord, namedEntries } from "./yaml-entry.ts";

export type DatasourceField = {
  name: string;
  type: string;
  isNullable: boolean;
  references?: string;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  minSize?: number;
  size?: number;
  /** Present when the YAML author set `default_value` (including `null`). */
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

export type DatasourceType = {
  name: string;
  datasourceType: string;
  fields: DatasourceField[];
  /** Single-column unique index field names (from `indexes:`). */
  uniqueIndexFields: string[];
  target?: string | null;
  optimisticConcurrency?: boolean;
};

export const DATASOURCE_TYPES_YAML = "datasource_types.yaml";

type YamlField = {
  name: string;
  type?: string;
  isNullable: boolean;
  references?: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  minSize?: number;
  size?: number;
  hasDefault: boolean;
  defaultValue?: string | number | boolean | null;
};

type YamlType = {
  name: string;
  datasourceType?: string;
  target?: string | null;
  optimisticConcurrency?: boolean;
  fields: YamlField[];
  uniqueIndexFields: string[];
};

const singleColumnUniqueIndexField = (body: unknown): string | undefined => {
  const raw = rec(body);
  if (raw.is_unique !== true) return undefined;
  const fields = raw.fields;
  if (!Array.isArray(fields) || fields.length !== 1) return undefined;
  const only = fields[0];
  return typeof only === "string" && only.length > 0 ? only : undefined;
};

const rec = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asDefaultValue = (
  value: unknown,
): string | number | boolean | null | undefined => {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
};

const inheritedType = (
  references: string,
  byName: Map<string, YamlType>,
  idType: string,
): string | undefined => {
  const [parentName, column, extra] = references.split(".");
  if (extra !== undefined || !parentName || !column) return undefined;
  const parent = byName.get(parentName);
  if (parent === undefined) return undefined;
  const pk = parent.fields.find((f) => f.isPrimaryKey);
  if (pk !== undefined) return pk.name === column ? pk.type : undefined;
  return column === "id" ? referenceFieldShape(idType).type : undefined;
};

const fieldType = (
  field: YamlField,
  byName: Map<string, YamlType>,
  idType: string,
): string => {
  if (field.type !== undefined) return field.type;
  if (field.references === undefined) return "string";
  const type = inheritedType(field.references, byName, idType);
  if (type === undefined) {
    throw new Error(
      `invariant: type-less reference "${field.name}" -> "${field.references}" has no resolvable parent primary key`,
    );
  }
  return type;
};

export const parseDatasourceTypes = (args: {
  yaml: string;
  idType: string;
}): DatasourceType[] => {
  const types: YamlType[] = namedEntries(rec(parse(args.yaml)).types).map(
    ([name, body]) => {
      const raw = rec(body);
      const uniqueIndexFields: string[] = [];
      for (const [, indexBody] of namedEntries(raw.indexes)) {
        const field = singleColumnUniqueIndexField(indexBody);
        if (field !== undefined && !uniqueIndexFields.includes(field)) {
          uniqueIndexFields.push(field);
        }
      }
      const hasOcc = Object.prototype.hasOwnProperty.call(
        raw,
        "use_optimistic_concurrency",
      );
      return {
        name,
        datasourceType: str(raw.datasource_type),
        target:
          raw.target === null
            ? null
            : str(raw.target),
        optimisticConcurrency: hasOcc
          ? raw.use_optimistic_concurrency === true
          : undefined,
        uniqueIndexFields,
        fields: namedEntries(raw.fields).map(([fname, fbody]) => {
          const f = rec(fbody);
          const hasDefault = Object.prototype.hasOwnProperty.call(
            f,
            "default_value",
          );
          return {
            name: fname,
            type: str(f.type),
            isNullable: f.is_nullable === true,
            references: str(f.references),
            isPrimaryKey: f.primary_key === true,
            isUnique: f.is_unique === true,
            minSize:
              typeof f.min_size === "number" && Number.isFinite(f.min_size)
                ? f.min_size
                : undefined,
            size:
              typeof f.size === "number" && Number.isFinite(f.size)
                ? f.size
                : undefined,
            hasDefault,
            defaultValue: hasDefault ? asDefaultValue(f.default_value) : undefined,
          };
        }),
      };
    },
  );
  const byName = new Map(types.map((t) => [t.name, t]));
  return types.map((t) => ({
    name: t.name,
    datasourceType: t.datasourceType ?? "standard",
    uniqueIndexFields: t.uniqueIndexFields,
    ...(t.target !== undefined ? { target: t.target } : {}),
    ...(t.optimisticConcurrency !== undefined
      ? { optimisticConcurrency: t.optimisticConcurrency }
      : {}),
    fields: t.fields.map((field) => ({
      name: field.name,
      type: fieldType(field, byName, args.idType),
      isNullable: field.isNullable,
      references: field.references,
      ...(field.isPrimaryKey ? { isPrimaryKey: true } : {}),
      ...(field.isUnique ? { isUnique: true } : {}),
      ...(field.minSize !== undefined ? { minSize: field.minSize } : {}),
      ...(field.size !== undefined ? { size: field.size } : {}),
      ...(field.hasDefault
        ? { hasDefault: true, defaultValue: field.defaultValue }
        : {}),
    })),
  }));
};

export type PrimaryKey = { column: string; idType: string };

const idTypeFromFieldType = (fieldType: string): string => {
  if (
    fieldType === "string" ||
    fieldType === "uuid" ||
    fieldType === "biginteger"
  ) {
    return fieldType;
  }
  return "integer";
};

/** First non-`id` `primary_key` field, else the project `id` / `idType`. */
export const primaryKeyFor = (
  entity: string,
  datasources: DatasourceType[],
  defaultIdType: string,
): PrimaryKey => {
  const table = datasources.find((d) => d.name === entity);
  const custom = table?.fields.find((f) => f.isPrimaryKey && f.name !== "id");
  if (custom === undefined) return { column: "id", idType: defaultIdType };
  return { column: custom.name, idType: idTypeFromFieldType(custom.type) };
};

/** Unique lookup columns: `is_unique` fields plus single-column unique indexes. */
export const uniqueLookupFields = (
  type: DatasourceType,
): Array<{ field: string; type: string; size?: number }> => {
  const out: Array<{ field: string; type: string; size?: number }> = [];
  const add = (name: string) => {
    if (out.some((e) => e.field === name)) return;
    const f = type.fields.find((x) => x.name === name);
    out.push({
      field: name,
      type: f?.type ?? "string",
      ...(f?.size !== undefined ? { size: f.size } : {}),
    });
  };
  for (const f of type.fields) {
    if (f.isUnique) add(f.name);
  }
  for (const name of type.uniqueIndexFields) add(name);
  return out;
};
