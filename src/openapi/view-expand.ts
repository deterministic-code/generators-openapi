import type {
  RawFieldDef,
  RawFieldEntry,
  RawTypeDef,
  RawTypeEntry,
  RawTypesDoc,
  DatasourceDirective,
  RouteViewTypeDirective,
  FilterTypeObj,
} from "./deterministic-shapes.ts";
import { singleEntry } from "./deterministic-shapes.ts";

const PRIMITIVES = new Set([
  "string",
  "character",
  "number",
  "integer",
  "smallinteger",
  "biginteger",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "binary",
  "uuid",
  "reference",
]);
const PRIMITIVE_ARRAYS = new Set([...PRIMITIVES].map((t) => `${t}[]`));

export type ParsedFieldType = {
  kind: "primitive" | "datasource" | "view";
  base: string;
  isArray: boolean;
};

export function parseFieldType(raw: string): ParsedFieldType {
  const isArray = raw.endsWith("[]");
  const base = isArray ? raw.slice(0, -2) : raw;

  if (raw === base && PRIMITIVES.has(base)) {
    return { kind: "primitive", base, isArray: false };
  }
  if (PRIMITIVE_ARRAYS.has(raw)) {
    return { kind: "primitive", base, isArray: true };
  }
  if (base.startsWith("datasource_types.")) {
    return {
      kind: "datasource",
      base: base.slice("datasource_types.".length),
      isArray,
    };
  }
  return { kind: "view", base, isArray };
}

export interface ShapedField {
  name: string;
  rawType: string;
  parsed: ParsedFieldType;
  isNullable: boolean;
  size: number | undefined;
  minSize: number | undefined;
}

export interface ShapedView {
  kind: "shaped";
  name: string;
  inherits: string | null;
  fields: ShapedField[];
  enrichments: Enrichment[];
  omit: string[];
}

export interface UnionView {
  kind: "union";
  name: string;
  members: string[];
}

export type NormalizedView = ShapedView | UnionView;

function normalizeShapedView(name: string, def: RawTypeDef): ShapedView {
  const inherits = def.inherits
    ? def.inherits.slice("datasource_types.".length)
    : null;
  const fields = (def.fields ?? []).map((f) => {
    const [fname, fdef] = singleEntry(f);
    return {
      name: fname,
      rawType: fdef.type,
      parsed: parseFieldType(fdef.type),
      isNullable: fdef.is_nullable === true,
      size: typeof fdef.size === "number" ? fdef.size : undefined,
      minSize: typeof fdef.min_size === "number" ? fdef.min_size : undefined,
    };
  });
  const enrichments = Array.isArray(def.__enrichments) ? def.__enrichments : [];
  const omit = Array.isArray(def.omit) ? def.omit : [];
  return { kind: "shaped", name, inherits, fields, enrichments, omit };
}

function normalizeUnionView(name: string, def: RawTypeDef): UnionView {
  return { kind: "union", name, members: def.one_of!.slice() };
}

export function normalizeView(entry: RawTypeEntry): NormalizedView {
  const [name, def] = singleEntry(entry);
  if (def && Array.isArray(def.one_of)) {
    return normalizeUnionView(name, def);
  }
  return normalizeShapedView(name, def);
}

export function normalizeAll(data: RawTypesDoc): NormalizedView[] {
  return (data.types ?? []).map(normalizeView);
}

function includeMatches(include: string | undefined, name: string): boolean {
  if (!include || include === "*") return true;
  return include
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .includes(name);
}

function compileFilter(
  filterExpr: string | undefined,
): (typeObj?: FilterTypeObj) => boolean {
  if (!filterExpr) return () => true;
  try {
    const fn = new Function("type", `return (${filterExpr});`);
    return (typeObj) => Boolean(fn(typeObj));
  } catch (e) {
    throw new Error(
      `datasource_types.filter is not a valid expression: ${(e as Error).message}`,
    );
  }
}

export interface DatasourceInfo {
  datasource_type: string | null;
  fields: Map<string, RawFieldDef>;
}

function buildDatasourceMap(
  datasourceData: RawTypesDoc,
): Map<string, DatasourceInfo> {
  const map = new Map<string, DatasourceInfo>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = singleEntry(entry);
    const fieldMap = new Map<string, RawFieldDef>();
    for (const fe of def.fields ?? []) {
      const [fname, fdef] = singleEntry(fe);
      fieldMap.set(fname, fdef);
    }
    map.set(name, {
      datasource_type: def.datasource_type ?? null,
      fields: fieldMap,
    });
  }
  return map;
}

function hasUpdateRouteSurface(
  datasourceInfo: DatasourceInfo | undefined,
): boolean {
  if (!datasourceInfo) return false;
  return datasourceInfo.datasource_type !== "readonly-lookup";
}

function targetIsEnrichable(target: DatasourceInfo | undefined): boolean {
  if (!target) return false;
  if (target.datasource_type === "readonly-lookup") return true;
  const nameField = target.fields.get("name");
  if (!nameField) return false;
  if (nameField.type !== "string") return false;
  if (nameField.is_unique !== true) return false;
  if (nameField.is_nullable === true) return false;
  return true;
}

function parseFkReference(fdef: RawFieldDef): { table: string } | null {
  if (fdef.type !== "number") return null;
  const ref = fdef.references;
  if (typeof ref !== "string") return null;
  const dot = ref.indexOf(".");
  const table = ref.slice(0, dot);
  const column = ref.slice(dot + 1);
  if (column !== "id") return null;
  return { table };
}

export interface Enrichment {
  fkColumn: string;
  prefix: string;
  targetTable: string;
  newField: string;
  targetIsReadonlyLookup: boolean;
  isNullable: boolean;
}

function computeEnrichmentsFor(
  _viewName: string,
  viewDef: RawTypeDef,
  dsMap: Map<string, DatasourceInfo>,
): Enrichment[] {
  if (typeof viewDef.inherits !== "string") return [];
  const prefix = "datasource_types.";
  const inheritedTable = viewDef.inherits.slice(prefix.length);
  return computeEnrichmentsFromDsFields(inheritedTable, dsMap);
}

function computeEnrichmentsFromDsFields(
  tableName: string,
  dsMap: Map<string, DatasourceInfo>,
): Enrichment[] {
  const inherited = dsMap.get(tableName);
  if (!inherited) return [];
  const enrichments: Enrichment[] = [];
  for (const [colName, fdef] of inherited.fields) {
    if (!colName.endsWith("_id")) continue;
    const ref = parseFkReference(fdef);
    if (!ref) continue;
    const target = dsMap.get(ref.table);
    if (!targetIsEnrichable(target)) continue;
    const localPrefix = colName.slice(0, -"_id".length);
    enrichments.push({
      fkColumn: colName,
      prefix: localPrefix,
      targetTable: ref.table,
      newField: `${localPrefix}_name`,
      targetIsReadonlyLookup: target!.datasource_type === "readonly-lookup",
      isNullable: fdef.is_nullable === true,
    });
  }
  return enrichments;
}

export function computeEnrichmentsForDatasourceType(
  entityName: string,
  datasourceData: RawTypesDoc,
): Enrichment[] {
  if (!datasourceData || typeof datasourceData !== "object") return [];
  const dsMap = buildDatasourceMap(datasourceData);
  if (!dsMap.has(entityName)) return [];
  const entry = datasourceData.types!.find(
    (e) => Object.keys(e)[0] === entityName,
  )!;
  const def = Object.values(entry)[0];
  // Junctions enrich like any entity (tag_id → tag_name); only readonly-lookups are targets, never enriched.
  if (def.datasource_type === "readonly-lookup") return [];
  return computeEnrichmentsFromDsFields(entityName, dsMap);
}

function applyAutoEnrich(
  types: RawTypeEntry[],
  dsMap: Map<string, DatasourceInfo>,
  mode: string,
): RawTypeEntry[] {
  if (mode === "service") return types;
  return types.map((entry) => {
    const [name, def] = singleEntry(entry);
    const enrichments = computeEnrichmentsFor(name, def, dsMap);
    if (enrichments.length === 0) return entry;
    const existing = def.fields!;
    const appended = enrichments.map((e) => ({
      [e.newField]: e.isNullable
        ? { type: "string", is_nullable: true }
        : { type: "string" },
    }));
    const nextDef = {
      ...def,
      fields: [...existing, ...appended],
      __enrichments: enrichments,
      __omitFromInherited: enrichments.map((e) => e.fkColumn),
    };
    return { [name]: nextDef };
  });
}

function updateAuditOmits(dsFieldMap: Map<string, RawFieldDef>): {
  auditOmits: string[];
  updateBodyOmits: string[];
  hasCustomPk: boolean;
} {
  const STANDARD_AUDIT_OMITS = ["id", "uuid", "created", "updated"];
  const auditOmits = STANDARD_AUDIT_OMITS.filter((n) => !dsFieldMap.has(n));
  const updateBodyOmits = [...auditOmits];
  let hasCustomPk = false;
  for (const [fieldName, fieldDef] of dsFieldMap) {
    if (fieldDef.primary_key === true && fieldName !== "id") {
      updateBodyOmits.push(fieldName);
      hasCustomPk = true;
    }
  }
  return { auditOmits, updateBodyOmits, hasCustomPk };
}

function isNonDerivableViewName(name: string): boolean {
  return (
    name.endsWith("_eager_body") ||
    name.endsWith("_eager_create_body") ||
    name.endsWith("_eager_patch_body") ||
    name.endsWith("_eager_row") ||
    name.endsWith("_eager_create_row") ||
    name.startsWith("create_") ||
    name.startsWith("update_")
  );
}

function updateVariantsFor(
  entry: RawTypeEntry,
  dsMap: Map<string, DatasourceInfo>,
  explicitNames: Set<string>,
): RawTypeEntry[] {
  const [name, def] = singleEntry(entry);
  if (typeof def.inherits !== "string") return [];
  const inheritedTable = def.inherits.slice("datasource_types.".length);
  const dsInfo = dsMap.get(inheritedTable);
  if (!hasUpdateRouteSurface(dsInfo)) return [];
  if (isNonDerivableViewName(name)) return [];
  const updateName = `update_${name}`;
  if (explicitNames.has(updateName)) return [];

  const inherits = `datasource_types.${inheritedTable}`;
  const { auditOmits, updateBodyOmits, hasCustomPk } = updateAuditOmits(
    dsInfo!.fields,
  );
  const variants: RawTypeEntry[] = [
    { [updateName]: { inherits, omit: updateBodyOmits, fields: [] } },
  ];

  if (hasCustomPk) {
    const createName = `create_${name}`;
    if (!explicitNames.has(createName)) {
      variants.push({
        [createName]: { inherits, omit: auditOmits, fields: [] },
      });
    }
  }
  return variants;
}

function deriveUpdateVariants(
  types: RawTypeEntry[],
  dsMap: Map<string, DatasourceInfo>,
): RawTypeEntry[] {
  const explicitNames = new Set(types.map((entry) => Object.keys(entry)[0]));
  const derived: RawTypeEntry[] = [];

  for (const entry of types) {
    derived.push(entry);
    derived.push(...updateVariantsFor(entry, dsMap, explicitNames));
  }

  return derived;
}

/** The `datasource_types` auto-enrich directive from a view doc's `includes:` list, or null. */
export function datasourceDirective(
  viewData: RawTypesDoc,
): DatasourceDirective | null {
  const includes = Array.isArray(viewData.includes) ? viewData.includes : [];
  return (includes.find((e) => e && e.datasource_types)?.datasource_types ??
    null) as DatasourceDirective | null;
}

/** The `view_type_routes` directive (filter + eager paths) from a routes doc's `includes:` list, or null. */
export function routeViewTypeDirective(
  routesData: RawTypesDoc | null,
): RouteViewTypeDirective | null {
  const includes = Array.isArray(routesData?.includes)
    ? routesData.includes
    : [];
  return (includes.find((e) => e && e.view_type_routes)?.view_type_routes ??
    null) as RouteViewTypeDirective | null;
}

function expandWithoutDirective(
  explicitEntries: RawTypeEntry[],
  datasourceData: RawTypesDoc | null,
): { types: RawTypeEntry[] } {
  const dsMap = datasourceData
    ? buildDatasourceMap(datasourceData)
    : new Map<string, DatasourceInfo>();
  if (dsMap.size > 0) {
    return { types: deriveUpdateVariants(explicitEntries, dsMap) };
  }
  return { types: explicitEntries };
}

function buildPassThroughs(
  datasourceData: RawTypesDoc,
  dsBlock: DatasourceDirective,
  explicitNames: Set<string>,
): RawTypeEntry[] {
  const { include, filter } = dsBlock;
  const predicate = compileFilter(filter);
  const passThroughs: RawTypeEntry[] = [];
  for (const dsEntry of datasourceData.types ?? []) {
    const [name, def] = singleEntry(dsEntry);
    if (explicitNames.has(name)) continue;
    if (!includeMatches(include, name)) continue;
    const typeObj = { name, datasource_type: def.datasource_type ?? null };
    if (!predicate(typeObj)) continue;
    passThroughs.push({
      [name]: { inherits: `datasource_types.${name}`, fields: [] },
    });
  }
  return passThroughs;
}

export function expandViewTypes(
  viewData: RawTypesDoc,
  datasourceData: RawTypesDoc | null,
  options: { mode?: string } = {},
): { types: RawTypeEntry[] } {
  const mode = options.mode ?? "api";
  const explicitEntries = viewData.types ?? [];
  const explicitNames = new Set<string>(
    explicitEntries.map((entry) => Object.keys(entry)[0]),
  );
  const dsBlock = datasourceDirective(viewData);

  if (!dsBlock || !datasourceData) {
    return expandWithoutDirective(explicitEntries, datasourceData);
  }

  const passThroughs = buildPassThroughs(
    datasourceData,
    dsBlock,
    explicitNames,
  );
  const dsMap = buildDatasourceMap(datasourceData);
  const withUpdates = deriveUpdateVariants(
    [...passThroughs, ...explicitEntries],
    dsMap,
  );

  if (dsBlock.auto_enrich !== true) return { types: withUpdates };
  return { types: applyAutoEnrich(withUpdates, dsMap, mode) };
}

function parseEagerWritePathSegments(p: unknown): string[] | null {
  const segments = String(p).split(".");
  if (segments.length < 2) return null;
  if (segments.some((s) => !s)) return null;
  return segments;
}

export interface ChildTableRef {
  kind: string;
  childTable: string;
  fkColumn?: string;
  junctionTable?: string;
}

function findChildTableFor(
  parent: string,
  fieldName: string,
  lookups: {
    dsMap: Map<string, DatasourceInfo>;
    viewByName: Map<string, RawTypeDef> | null;
  },
): ChildTableRef | null {
  const { dsMap, viewByName } = lookups;
  const fieldFromView = lookupViewFieldRef(parent, fieldName, viewByName);
  if (fieldFromView) {
    const { elementType, refTable, refColumn } = fieldFromView;
    if (refTable === elementType) {
      return {
        kind: "direct-fk",
        childTable: elementType,
        fkColumn: refColumn,
      };
    }
    const refInfo = dsMap.get(refTable);
    if (refInfo && refInfo.datasource_type === "many-to-many") {
      return { kind: "m2m", childTable: elementType, junctionTable: refTable };
    }
  }

  // Fallback: scan datasource for a direct-FK child whose pluralized name matches.
  for (const [table, info] of dsMap) {
    if (table === parent) continue;
    for (const [colName, fdef] of info.fields) {
      const ref = parseFkReference(fdef);
      if (
        ref &&
        ref.table === parent &&
        (`${parent}_id` === colName || colName.endsWith("_id"))
      ) {
        if (`${fieldName}` === pluralize(table)) {
          return { kind: "direct-fk", childTable: table, fkColumn: colName };
        }
      }
    }
  }
  return null;
}

function lookupViewFieldRef(
  parent: string,
  fieldName: string,
  viewByName: Map<string, RawTypeDef> | null,
): { elementType: string; refTable: string; refColumn: string } | null {
  if (!viewByName) return null;
  const view = viewByName.get(parent);
  if (!view) return null;
  for (const f of view.fields!) {
    const [name, def] = singleEntry(f);
    if (name !== fieldName) continue;
    const arrayMatch = /^datasource_types\.([a-z_][a-z0-9_]*)\[\]$/.exec(
      def.type,
    );
    const refMatch =
      /^datasource_types\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(
        def.references ?? "",
      );
    if (!arrayMatch || !refMatch) return null;
    return {
      elementType: arrayMatch[1],
      refTable: refMatch[1],
      refColumn: refMatch[2],
    };
  }
  return null;
}

function pluralize(name: string): string {
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

function copyDatasourceField(fdef: RawFieldDef): {
  type: string;
  size?: number;
  min_size?: number;
} {
  const out: { type: string; size?: number; min_size?: number } = {
    type: fdef.type,
  };
  if (typeof fdef.size !== "undefined") out.size = fdef.size;
  if (typeof fdef.min_size !== "undefined") out.min_size = fdef.min_size;
  return out;
}

interface ChildField {
  fieldName: string;
  kind: string;
  childTable: string;
  fkColumn?: string;
}

interface IncomingRef {
  kind: string;
  fkColumn?: string;
}

interface FoldEagerWriteArgs {
  segments: string[];
  childrenByView: Map<string, Map<string, ChildField>>;
  incomingByView: Map<string, IncomingRef>;
  dsMap: Map<string, DatasourceInfo>;
  viewByName: Map<string, RawTypeDef> | null;
}

/** Walk each eager_write_path into a parent→children graph: childrenByView maps a view to its selected array-child fields; incomingByView records each child's inbound FK; rootViews holds the path roots. */
// Fold one eager_write_path's segments into the graph maps (childrenByView / incomingByView), stopping at the first segment whose child table can't be resolved.
function foldEagerWritePath({
  segments,
  childrenByView,
  incomingByView,
  dsMap,
  viewByName,
}: FoldEagerWriteArgs): void {
  let current = segments[0];
  for (let i = 1; i < segments.length; i++) {
    const fieldName = segments[i];
    const found = findChildTableFor(current, fieldName, { dsMap, viewByName });
    if (!found) break;
    if (!childrenByView.has(current)) childrenByView.set(current, new Map());
    const bucket = childrenByView.get(current)!;
    if (!bucket.has(fieldName)) {
      bucket.set(fieldName, {
        fieldName,
        kind: found.kind,
        childTable: found.childTable,
        fkColumn: found.fkColumn,
      });
    }
    if (!incomingByView.has(found.childTable)) {
      incomingByView.set(found.childTable, {
        kind: found.kind,
        fkColumn: found.fkColumn,
      });
    }
    current = found.childTable;
  }
}

function buildEagerWriteGraph(
  paths: unknown[],
  dsMap: Map<string, DatasourceInfo>,
  viewByName: Map<string, RawTypeDef> | null,
): {
  childrenByView: Map<string, Map<string, ChildField>>;
  incomingByView: Map<string, IncomingRef>;
  rootViews: Set<string>;
} {
  const childrenByView = new Map<string, Map<string, ChildField>>();
  const incomingByView = new Map<string, IncomingRef>();
  const rootViews = new Set<string>();
  for (const raw of paths) {
    const segments = parseEagerWritePathSegments(raw);
    if (!segments) continue;
    rootViews.add(segments[0]);
    foldEagerWritePath({
      segments,
      childrenByView,
      incomingByView,
      dsMap,
      viewByName,
    });
  }
  return { childrenByView, incomingByView, rootViews };
}

function childArrayFields(
  kids: Map<string, ChildField> | undefined,
  rowSuffix: string,
): RawFieldEntry[] {
  const fields: RawFieldEntry[] = [];
  for (const c of kids?.values() ?? []) {
    fields.push({
      [c.fieldName]: { type: `${c.childTable}${rowSuffix}`, is_nullable: true },
    });
  }
  return fields;
}

interface EagerCtx {
  out: RawTypeEntry[];
  dsMap: Map<string, DatasourceInfo>;
  childrenByView: Map<string, Map<string, ChildField>>;
  incomingByView: Map<string, IncomingRef>;
  generatedRows: Set<string>;
  generatedCreateRows: Set<string>;
}

/** Generate the `<view>_eager_row` / `<view>_eager_create_row` inner types for a child view (deduped via ctx.generated*). ctx = { out, childrenByView, incomingByView, generatedRows, generatedCreateRows }. */
function generateEagerRows(ctx: EagerCtx, viewName: string): void {
  const incoming = ctx.incomingByView.get(viewName);
  const fkOmit =
    incoming && incoming.kind !== "m2m" && incoming.fkColumn
      ? [incoming.fkColumn]
      : [];
  const omit = ["id", "uuid", "created", "updated", ...fkOmit];
  const kids = ctx.childrenByView.get(viewName);

  if (!ctx.generatedRows.has(viewName)) {
    ctx.generatedRows.add(viewName);
    ctx.out.push({
      [`${viewName}_eager_row`]: {
        inherits: `datasource_types.${viewName}`,
        omit,
        fields: [
          { id: { type: "number", is_nullable: true } },
          ...childArrayFields(kids, "_eager_row[]"),
        ],
      },
    });
  }
  if (!ctx.generatedCreateRows.has(viewName)) {
    ctx.generatedCreateRows.add(viewName);
    ctx.out.push({
      [`${viewName}_eager_create_row`]: {
        inherits: `datasource_types.${viewName}`,
        omit,
        fields: childArrayFields(kids, "_eager_create_row[]"),
      },
    });
  }
}

/** Generate the `<root>_eager_body` / `_eager_create_body` / `_eager_patch_body` request bodies for a root view. ctx = { out, dsMap, childrenByView }. */
function generateEagerRootBodies(ctx: EagerCtx, rootName: string): void {
  const parentInfo = ctx.dsMap.get(rootName);
  const kids = ctx.childrenByView.get(rootName);
  if (!parentInfo || !kids) return;

  const bodyFields = childArrayFields(kids, "_eager_row[]");
  const omit = ["id", "uuid", "created", "updated"];
  ctx.out.push({
    [`${rootName}_eager_body`]: {
      inherits: `datasource_types.${rootName}`,
      omit,
      fields: bodyFields,
    },
  });
  ctx.out.push({
    [`${rootName}_eager_create_body`]: {
      inherits: `datasource_types.${rootName}`,
      omit,
      fields: childArrayFields(kids, "_eager_create_row[]"),
    },
  });

  const patchEnrichments = computeEnrichmentsFromDsFields(rootName, ctx.dsMap);
  const patchFkSwap = new Map(patchEnrichments.map((e) => [e.fkColumn, e]));
  const patchParentFields: RawFieldEntry[] = [];
  for (const [colName, fdef] of parentInfo.fields) {
    if (patchFkSwap.has(colName)) continue;
    patchParentFields.push({
      [colName]: { ...copyDatasourceField(fdef), is_nullable: true },
    });
  }
  for (const e of patchEnrichments) {
    patchParentFields.push({
      [e.newField]: { type: "string", is_nullable: true },
    });
  }
  ctx.out.push({
    [`${rootName}_eager_patch_body`]: {
      fields: [...patchParentFields, ...bodyFields],
      ...(patchEnrichments.length > 0
        ? { __enrichments: patchEnrichments }
        : {}),
    },
  });
}

export function deriveEagerWriteBodyTypes(
  routesData: RawTypesDoc,
  datasourceData: RawTypesDoc,
  viewData: RawTypesDoc,
): RawTypeEntry[] {
  const paths = routeViewTypeDirective(routesData)?.eager_write_path;
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const dsMap = buildDatasourceMap(datasourceData);
  const viewByName = viewData ? indexViewTypes(viewData) : null;
  const { childrenByView, incomingByView, rootViews } = buildEagerWriteGraph(
    paths,
    dsMap,
    viewByName,
  );

  const childViews = new Set<string>();
  for (const kids of childrenByView.values()) {
    for (const c of kids.values()) childViews.add(c.childTable);
  }

  const ctx: EagerCtx = {
    out: [],
    dsMap,
    childrenByView,
    incomingByView,
    generatedRows: new Set(),
    generatedCreateRows: new Set(),
  };
  for (const root of rootViews) generateEagerRootBodies(ctx, root);
  for (const v of childViews) generateEagerRows(ctx, v);
  return ctx.out;
}

const ARRAY_DS_TYPE_RE = /^datasource_types\.([a-z_][a-z0-9_]*)\[\]$/;

function isEagerChildField(fdef: RawFieldDef): boolean {
  if (!ARRAY_DS_TYPE_RE.test(fdef.type)) return false;
  return typeof fdef.references === "string";
}

function indexViewTypes(viewData: RawTypesDoc): Map<string, RawTypeDef> {
  const map = new Map<string, RawTypeDef>();
  for (const entry of viewData?.types ?? []) {
    const [name, def] = singleEntry(entry);
    map.set(name, def);
  }
  return map;
}

interface FoldEagerProjectionArgs {
  segments: string[];
  viewByName: Map<string, RawTypeDef>;
  out: Map<string, Set<string>>;
}

// Fold one eager_path's segments into the projection map `out` (view → Set of projected field names), following array+reference hops until a non-array field.
function foldEagerPathProjection({
  segments,
  viewByName,
  out,
}: FoldEagerProjectionArgs): void {
  let currentName = segments[0];
  let currentDef = viewByName.get(currentName);
  if (!currentDef) return;
  for (let i = 1; i < segments.length; i++) {
    const fieldName = segments[i];
    if (!out.has(currentName)) out.set(currentName, new Set());
    out.get(currentName)!.add(fieldName);
    const fieldEntry = (currentDef?.fields ?? []).find((f) =>
      Object.prototype.hasOwnProperty.call(f, fieldName),
    );
    if (!fieldEntry) break;
    const m = ARRAY_DS_TYPE_RE.exec(fieldEntry[fieldName].type);
    if (!m) break;
    currentName = m[1];
    currentDef = viewByName.get(m[1]);
  }
}

export function collectEagerPathProjections(
  routesData: RawTypesDoc,
  viewData: RawTypesDoc,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const paths = routeViewTypeDirective(routesData)?.eager_path;
  if (!Array.isArray(paths)) return out;
  const viewByName = indexViewTypes(viewData);
  for (const raw of paths) {
    const segments = String(raw).split(".");
    if (segments.length < 2) continue;
    foldEagerPathProjection({ segments, viewByName, out });
  }
  return out;
}

export function projectViewTypesByEagerPath(
  viewData: RawTypesDoc,
  routesData: RawTypesDoc,
): RawTypesDoc {
  const projections = collectEagerPathProjections(routesData, viewData);
  const types = (viewData?.types ?? []).map((entry) => {
    const [name, def] = singleEntry(entry);
    if (!def || !Array.isArray(def.fields)) return entry;
    const projectedSet = projections.get(name);
    const fields = def.fields.filter((f) => {
      const [fname, fdef] = singleEntry(f);
      if (!isEagerChildField(fdef)) return true;
      return projectedSet ? projectedSet.has(fname) : false;
    });
    return { [name]: { ...def, fields } };
  });
  return { ...viewData, types };
}
