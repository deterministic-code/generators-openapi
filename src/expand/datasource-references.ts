import { DatasourceSettings } from "./datasource-settings.ts";

interface FieldDef {
  type?: string;
  size?: number;
  references?: string;
  primary_key?: boolean;
  [key: string]: unknown;
}
type FieldEntry = Record<string, FieldDef>;
interface EntityDef {
  fields?: FieldEntry[];
  [key: string]: unknown;
}
type TypeEntry = Record<string, EntityDef>;
export interface DatasourceTypes {
  types?: TypeEntry[];
}

interface ReferenceParentType {
  type: string | undefined;
  size: number | undefined;
}

/** The parent entity's `def` in a parsed datasource_types `types` array, or null when no entity by that name exists. */
function findEntityDef(
  types: TypeEntry[],
  entityName: string,
): EntityDef | null {
  for (const entry of types) {
    const [name, def] = Object.entries(entry)[0];
    if (name === entityName) return def;
  }
  return null;
}

/** The `[name, def]` of a parent's explicit `primary_key: true` field, or null when the parent relies on the implicit `id` column. */
function explicitPkEntry(parentDef: EntityDef): [string, FieldDef] | null {
  const entry = (parentDef.fields ?? []).find(
    (f) => Object.values(f)[0]?.primary_key === true,
  );
  return entry ? Object.entries(entry)[0] : null;
}

/** The `{ type, size }` a `references: <entity>.<col>` FK inherits from the parent primary key it targets, or null when the reference does not resolve to a PK — a non-PK column, an unknown/malformed parent — leaving those to the field's declared type and to reference validation. The one place the parent-PK type is derived, shared by the SQL generator, the materialize pass, and the semantics validator. */
export function resolveReferenceParentType(
  references: unknown,
  types: unknown,
  idType: string,
): ReferenceParentType | null {
  const parts = String(references).split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  const [parentEntity, parentCol] = parts;
  if (!Array.isArray(types)) return null;
  const parentDef = findEntityDef(types, parentEntity);
  if (!parentDef) return null;
  const pk = explicitPkEntry(parentDef);
  if (pk) {
    const [pkName, pkDef] = pk;
    return parentCol === pkName ? { type: pkDef.type, size: pkDef.size } : null;
  }
  return parentCol === "id"
    ? new DatasourceSettings({ idType }).referenceFieldShape()
    : null;
}

/** Stamp the inherited parent-PK `type`/`size` onto every `references` field that OMITS its own `type` (the type-less FK form), so every downstream generator that reads `field.type` sees the resolved type rather than `undefined`. Declared-type references are left byte-for-byte untouched. A type-less reference that cannot resolve a parent type is an invariant break — the validator gates it upstream — so it throws rather than generating an untyped column. Mutates and returns `datasourceTypes`. */
export function materializeReferenceTypes(
  datasourceTypes: DatasourceTypes,
  idType: string,
): DatasourceTypes {
  for (const entry of datasourceTypes.types ?? []) {
    const def = Object.values(entry)[0];
    for (const fieldEntry of def.fields ?? []) {
      const [fieldName, fdef] = Object.entries(fieldEntry)[0];
      if (!fdef.references || fdef.type !== undefined) continue;
      const parent = resolveReferenceParentType(
        fdef.references,
        datasourceTypes.types,
        idType,
      );
      if (!parent) {
        throw new Error(
          `invariant: type-less reference "${fieldName}" -> "${fdef.references}" has no resolvable parent primary key`,
        );
      }
      fieldEntry[fieldName] =
        parent.size !== undefined
          ? { type: parent.type, size: parent.size, ...fdef }
          : { type: parent.type, ...fdef };
    }
  }
  return datasourceTypes;
}
