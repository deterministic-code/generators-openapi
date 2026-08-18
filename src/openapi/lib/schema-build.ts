import {
  expandViewTypes,
  parseFieldType,
  type ParsedFieldType,
  type Enrichment,
} from "../view-expand.ts";
import { DatasourceSettings } from "../datasource-settings.ts";
import type {
  RawFieldDef,
  RawTypeDef,
  RawTypesDoc,
} from "../deterministic-shapes.ts";
import { FieldConverter, fieldConverter } from "../../field-converter.ts";

const SAMPLE_CONVERTER = new FieldConverter(fieldConverter);

type SchemaDefault = string | number | boolean | null;

export interface OpenApiSchema {
  type?: string;
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  enum?: string[];
  $ref?: string;
  nullable?: boolean;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  maxLength?: number;
  default?: SchemaDefault;
  "x-references"?: string;
}

interface DatasourceFieldDef extends RawFieldDef {
  default_value?: SchemaDefault;
}

type SeedEntry = Record<string, { name?: string }>;

interface DsTypeDef extends RawTypeDef {
  seeds?: SeedEntry[];
}

interface FieldMapping {
  [column: string]: { source?: string };
}

interface DatasourceMappingBody {
  source?: string;
  field_mappings?: FieldMapping[];
}

type DatasourceMappingEntry = Record<string, DatasourceMappingBody>;

interface DatasourceDoc extends RawTypesDoc {
  datasource_mappings?: DatasourceMappingEntry[];
}

interface ViewField {
  name: string;
  rawType: string;
  parsed?: ParsedFieldType;
  isNullable?: boolean;
  size?: number;
  default_value?: SchemaDefault;
}

/** The integer-id fallback for the exported builders when a caller passes no `DatasourceSettings` — keeps the historical 2-arg call sites (integer projects) byte-identical. */
const DEFAULT_DS = new DatasourceSettings();

const STANDARD_COLUMNS: { name: string; schema: OpenApiSchema }[] = [
  { name: "id", schema: { type: "integer" } },
  { name: "uuid", schema: { type: "string", format: "uuid" } },
  { name: "created", schema: { type: "string", format: "date-time" } },
  { name: "updated", schema: { type: "string", format: "date-time" } },
];

function entryOf<T>(obj: Record<string, T>): [string, T] {
  const keys = Object.keys(obj);
  return [keys[0], obj[keys[0]]];
}

function indexDatasourceTypes(
  datasourceData: DatasourceDoc | null | undefined,
): Map<string, DsTypeDef> {
  const byName = new Map<string, DsTypeDef>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = entryOf<DsTypeDef>(entry);
    byName.set(name, def);
  }
  return byName;
}

function collectMappedColumns(
  entry: DatasourceMappingBody,
  out: Set<string>,
): void {
  const fms = entry.field_mappings;
  if (!Array.isArray(fms)) return;
  for (const fm of fms) {
    if (!fm || typeof fm !== "object") continue;
    const cols = Object.keys(fm);
    if (cols.length !== 1) continue;
    out.add(cols[0]);
  }
}

// runtime translates physical→logical via these mappings; schema must list them too
function mappedLogicalFieldNames(
  datasourceData: DatasourceDoc | null | undefined,
  entityName: string,
): Set<string> {
  const out = new Set<string>();
  const raw = datasourceData?.datasource_mappings;
  if (!Array.isArray(raw)) return out;
  for (const mapping of raw) {
    if (!mapping || typeof mapping !== "object") continue;
    if (!(entityName in mapping)) continue;
    const entry = mapping[entityName];
    if (!entry || typeof entry !== "object") continue;
    collectMappedColumns(entry, out);
  }
  return out;
}

export function schemaForPrimitive(
  type: string,
  opts: { size?: number } = {},
): OpenApiSchema {
  switch (type) {
    case "string":
    case "character": {
      const out: OpenApiSchema = { type: "string" };
      if (typeof opts.size === "number") out.maxLength = opts.size;
      return out;
    }
    case "decimal":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
    case "smallinteger":
      return { type: "integer", format: "int32" };
    case "biginteger":
      return { type: "integer", format: "int64" };
    case "float":
      return { type: "number", format: "float" };
    case "boolean":
      return { type: "boolean" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "binary":
      return { type: "string", format: "byte" };
    case "uuid":
      return { type: "string", format: "uuid" };
    case "reference":
      return { type: "integer" };
    default:
      throw new Error(`Unknown datasource field type: ${type}`);
  }
}

/** The `FieldConverter` type key a scalar OpenAPI schema samples as — the inverse of `schemaForPrimitive`, resolving `format` first (`date-time`/`byte`/`uuid`/`date`/`email` all carry `type: "string"`). The single home mapping the OpenAPI wire shape back onto the converter's keyspace; throws on an unmapped shape rather than sampling it as a bad string. */
export function converterTypeForSchema(schema: {
  type?: unknown;
  format?: unknown;
}): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  if (format === "date-time") return "datetime";
  if (format === "byte") return "binary";
  if (format === "uuid") return "uuid";
  if (format === "date") return "date";
  if (format === "email") return "email";
  if (format === "int32") return "integer";
  if (format === "int64") return "biginteger";
  if (format === "float") return "float";
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string" || schema.type === undefined) return "string";
  throw new Error(`no converter type for schema ${JSON.stringify(schema)}`);
}

function applyFieldModifiers(
  schema: OpenApiSchema,
  fdef: DatasourceFieldDef,
): OpenApiSchema {
  let out = schema;
  if (fdef.is_nullable === true) {
    out = { ...out, nullable: true };
  }
  if (Object.prototype.hasOwnProperty.call(fdef, "default_value")) {
    out = { ...out, default: fdef.default_value };
  }
  return out;
}

function fkOrPrimitiveSchema(
  fdef: DatasourceFieldDef,
  ds: DatasourceSettings,
): OpenApiSchema {
  if (ds.referenceIsUuid(fdef.references)) {
    return applyFieldModifiers({ type: "string", format: "uuid" }, fdef);
  }
  if (
    typeof fdef.references === "string" &&
    (!fdef.type || fdef.type === "reference")
  ) {
    return applyFieldModifiers({ type: "integer" }, fdef);
  }
  return applyFieldModifiers(
    schemaForPrimitive(fdef.type, { size: fdef.size }),
    fdef,
  );
}

export function datasourceFieldSchema(
  fdef: DatasourceFieldDef,
  ds: DatasourceSettings = DEFAULT_DS,
): OpenApiSchema {
  const baseSchema = fkOrPrimitiveSchema(fdef, ds);
  // x-references surfaces the FK target ("user.id") so the e2e seed planner discovers author_id → user without a column-name heuristic.
  if (typeof fdef.references === "string" && fdef.references.length > 0) {
    return { ...baseSchema, "x-references": fdef.references };
  }
  return baseSchema;
}

export function viewFieldSchema(field: ViewField): OpenApiSchema {
  const parsed = field.parsed ?? parseFieldType(field.rawType);
  if (parsed.kind === "primitive") {
    const inner = schemaForPrimitive(parsed.base, { size: field.size });
    if (parsed.isArray) return { type: "array", items: inner };
    let out = inner;
    if (field.isNullable) out = { ...out, nullable: true };
    if (Object.prototype.hasOwnProperty.call(field, "default_value")) {
      out = { ...out, default: field.default_value };
    }
    return out;
  }
  const ref: OpenApiSchema = { $ref: `#/components/schemas/${parsed.base}` };
  if (parsed.isArray) return { type: "array", items: ref };
  return ref;
}

/** Whether a component key names a synthetic write-body DTO (create/update/eager) rather than an authored read view — the shared predicate `frontend_types` reuses to keep read-only barrels free of request-body types. */
export function isWriteDtoViewName(name: string): boolean {
  return (
    name.startsWith("update_") ||
    name.startsWith("create_") ||
    name.endsWith("_eager_body") ||
    name.endsWith("_eager_create_body") ||
    name.endsWith("_eager_patch_body") ||
    name.endsWith("_eager_row") ||
    name.endsWith("_eager_create_row")
  );
}

function isFieldRequired(fdef: DatasourceFieldDef): boolean {
  if (fdef.is_nullable === true) return false;
  if (Object.prototype.hasOwnProperty.call(fdef, "default_value")) return false;
  return true;
}

/** The standard id/uuid/created/updated columns to include, as `[name, schema]` — uuid dropped under a uuid id_type, and any column the entity declares itself or omits skipped. */
function standardColumnEntries(
  ds: DatasourceSettings,
  omitSet: Set<string>,
  userDeclared: Set<string>,
): Array<[string, OpenApiSchema]> {
  const entries: Array<[string, OpenApiSchema]> = [];
  for (const std of STANDARD_COLUMNS) {
    if (std.name === "uuid" && !ds.withUuidColumn) continue;
    if (omitSet.has(std.name) || userDeclared.has(std.name)) continue;
    const schema = std.name === "id" ? ds.openApiIdSchema() : { ...std.schema };
    entries.push([std.name, schema]);
  }
  return entries;
}

/** The entity's own datasource columns as `[name, schema, required]`. */
function datasourceFieldEntries(
  dsDef: RawTypeDef,
  ds: DatasourceSettings,
  omitSet: Set<string>,
): Array<[string, OpenApiSchema, boolean]> {
  const entries: Array<[string, OpenApiSchema, boolean]> = [];
  for (const f of Array.isArray(dsDef?.fields) ? dsDef.fields : []) {
    const [fname, fdef] = entryOf(f);
    if (omitSet.has(fname)) continue;
    entries.push([
      fname,
      datasourceFieldSchema(fdef, ds),
      isFieldRequired(fdef),
    ]);
  }
  return entries;
}

interface BuildSchemaOptions {
  omitSet?: Set<string>;
  includeRequired?: boolean;
  ds?: DatasourceSettings;
}

export function buildSchemaForView(
  dsDef: RawTypeDef,
  viewFields: ViewField[],
  options: BuildSchemaOptions = {},
): OpenApiSchema {
  const { omitSet, includeRequired = false } = options;
  const ds = options.ds ?? DEFAULT_DS;
  const props: Record<string, OpenApiSchema> = {};
  const required: string[] = [];
  const userDeclared = declaredFieldNames(dsDef);

  for (const [name, schema] of standardColumnEntries(
    ds,
    omitSet!,
    userDeclared,
  )) {
    props[name] = schema;
    if (includeRequired) required.push(name);
  }
  for (const [name, schema, req] of datasourceFieldEntries(
    dsDef,
    ds,
    omitSet!,
  )) {
    props[name] = schema;
    if (includeRequired && req) required.push(name);
  }
  for (const vf of viewFields) {
    props[vf.name] = viewFieldSchema(vf);
    if (includeRequired && !vf.isNullable) required.push(vf.name);
  }

  return includeRequired
    ? { type: "object", required, properties: props }
    : { type: "object", properties: props };
}

function buildDtoSchema(viewFields: ViewField[]): OpenApiSchema {
  const props: Record<string, OpenApiSchema> = {};
  const required: string[] = [];
  for (const vf of viewFields) {
    props[vf.name] = viewFieldSchema(vf);
    if (!vf.isNullable) required.push(vf.name);
  }
  return { type: "object", required, properties: props };
}

/** The standard id/uuid/created/updated columns a write-response includes — id/uuid suppressed for a custom-PK entity, uuid/audit suppressed for a readonly-lookup. */
function writeResponseStandardColumns(
  stdIncluded: (name: string) => boolean,
  ds: DatasourceSettings,
  {
    hasCustomPk,
    isReadonlyLookup,
  }: {
    hasCustomPk: boolean;
    isReadonlyLookup: boolean;
  },
): Record<string, OpenApiSchema> {
  const props: Record<string, OpenApiSchema> = {};
  if (stdIncluded("id") && !hasCustomPk) props.id = ds.openApiIdSchema();
  if (!isReadonlyLookup) {
    if (ds.withUuidColumn && stdIncluded("uuid") && !hasCustomPk)
      props.uuid = { type: "string", format: "uuid" };
    if (stdIncluded("created"))
      props.created = { type: "string", format: "date-time" };
    if (stdIncluded("updated"))
      props.updated = { type: "string", format: "date-time" };
  }
  return props;
}

interface InheritedWriteContext {
  def: RawTypeDef;
  dsDef: DsTypeDef;
  dsByName: Map<string, DsTypeDef>;
  inheritsName: string;
}

/** Resolve a view name to its inherited datasource context for the write-response builder, or null when the view is missing / doesn't inherit a datasource type. */
function resolveInheritedWriteView(
  viewName: string,
  viewData: RawTypesDoc,
  datasourceData: DatasourceDoc | null | undefined,
): InheritedWriteContext | null {
  const dsByName = indexDatasourceTypes(datasourceData);
  const expanded = expandViewTypes(
    viewData,
    datasourceData as RawTypesDoc | null,
  );
  const view = expanded.types.find(
    (entry) => Object.keys(entry)[0] === viewName,
  );
  if (!view) return null;
  const def = view[viewName];
  if (
    !def ||
    typeof def.inherits !== "string" ||
    !def.inherits.startsWith("datasource_types.")
  ) {
    return null;
  }
  const inheritsName = def.inherits.slice("datasource_types.".length);
  const dsDef = dsByName.get(inheritsName);
  if (!dsDef) return null;
  return { def, dsDef, dsByName, inheritsName };
}

/** Fill a write-response's non-standard props: inherited datasource columns, enriched name-enum fields, and eager child arrays. */
function addWriteResponseFields(
  props: Record<string, OpenApiSchema>,
  ctx: InheritedWriteContext,
  ds: DatasourceSettings = DEFAULT_DS,
): void {
  const { def, dsDef, dsByName } = ctx;
  const omitFromInherited = new Set<string>(
    Array.isArray(def.__omitFromInherited) ? def.__omitFromInherited : [],
  );
  for (const f of Array.isArray(dsDef.fields) ? dsDef.fields : []) {
    const [fname, fdef] = entryOf(f);
    if (omitFromInherited.has(fname)) continue;
    props[fname] = datasourceFieldSchema(fdef, ds);
  }
  for (const e of Array.isArray(def.__enrichments) ? def.__enrichments : []) {
    const named = enrichmentNameSchema(e, dsByName);
    props[e.newField] = e.isNullable ? { ...named, nullable: true } : named;
  }
  for (const f of Array.isArray(def.fields) ? def.fields : []) {
    const [fname, fdef] = entryOf(f);
    if (props[fname]) continue;
    const parsed = parseFieldType(fdef.type);
    if (!parsed.isArray) continue;
    if (parsed.kind !== "datasource" && parsed.kind !== "view") continue;
    props[fname] = {
      type: "array",
      items: { $ref: `#/components/schemas/${parsed.base}` },
    };
  }
}

interface BuildWriteResponseOptions {
  datasourceData?: DatasourceDoc | null;
  ds?: DatasourceSettings;
}

export function buildWriteResponseSchema(
  viewName: string,
  viewData: RawTypesDoc,
  opts: BuildWriteResponseOptions = {},
): OpenApiSchema | null {
  const { datasourceData, ds = DEFAULT_DS } = opts;
  const ctx = resolveInheritedWriteView(viewName, viewData, datasourceData);
  if (!ctx) return null;
  const { dsDef, inheritsName } = ctx;
  const hasCustomPk = hasCustomPrimaryKey(dsDef);
  const mappedNames = mappedLogicalFieldNames(datasourceData, inheritsName);
  const declared = declaredFieldNames(dsDef);
  const stdIncluded = (name: string): boolean =>
    !hasCustomPk || declared.has(name) || mappedNames.has(name);
  const props = writeResponseStandardColumns(stdIncluded, ds, {
    hasCustomPk,
    isReadonlyLookup: dsDef.datasource_type === "readonly-lookup",
  });
  addWriteResponseFields(props, ctx, ds);
  return { type: "object", properties: props };
}

/** The schema for an enriched name field, always carrying `x-references: <target>.name` so it self-identifies as an FK-name reference — the marker FK-name consumers key on instead of a `<x>_name` column-name guess (which false-matched genuine scalar columns like `legacy_review.reviewer_name`). A `readonly-lookup` target WITH seeds also pins a closed `enum` of those seed names; a writeable/self-referential target gains rows at runtime, so it offers no enum; a SEEDLESS readonly-lookup offers neither. */
function enrichmentNameSchema(
  enrichment: Enrichment,
  dsByName: Map<string, DsTypeDef>,
): OpenApiSchema {
  const target = dsByName.get(enrichment.targetTable);
  const nameRef = `${enrichment.targetTable}.name`;
  if (target?.datasource_type !== "readonly-lookup")
    return { type: "string", "x-references": nameRef };
  const seeds = Array.isArray(target.seeds) ? target.seeds : [];
  const names: string[] = [];
  for (const seed of seeds) {
    const seedEntry = Object.entries(seed)[0];
    if (!seedEntry) continue;
    const [, seedData] = seedEntry;
    if (seedData && typeof seedData.name === "string")
      names.push(seedData.name);
  }
  return names.length > 0
    ? { type: "string", enum: names, "x-references": nameRef }
    : { type: "string", "x-references": nameRef };
}

/** Replace each recorded `__enrichments` field on a built component with its lookup name-enum schema, preserving `nullable`. Runs for BOTH inheriting views AND fields-only views (e.g. `<e>_eager_patch_body`), so an enriched name field keeps its enum on PATCH exactly as it has it on PUT/create — previously the fields-only branch skipped enrichment and dropped the enum. */
function applyEnrichmentNames(
  schema: OpenApiSchema,
  def: RawTypeDef,
  dsByName: Map<string, DsTypeDef>,
): void {
  const enrichments = Array.isArray(def.__enrichments) ? def.__enrichments : [];
  for (const e of enrichments) {
    const existing = schema.properties![e.newField];
    const named = enrichmentNameSchema(e, dsByName);
    schema.properties![e.newField] =
      existing.nullable === true ? { ...named, nullable: true } : named;
  }
}

/** The field names a datasource type declares (its `fields` are single-key maps post-`expandViewTypes`). */
function declaredFieldNames(dsDef: RawTypeDef): Set<string> {
  return new Set((dsDef.fields ?? []).map((entry) => Object.keys(entry)[0]));
}

/** Whether a datasource type declares its own non-`id` primary key (so the standard id/uuid/audit columns aren't auto-added). */
function hasCustomPrimaryKey(dsDef: RawTypeDef): boolean {
  return (dsDef.fields ?? []).some((entry) => {
    const fieldName = Object.keys(entry)[0];
    const fieldDef = entry[fieldName];
    return (
      fieldDef &&
      typeof fieldDef === "object" &&
      fieldDef.primary_key === true &&
      fieldName !== "id"
    );
  });
}

function toViewFields(def: RawTypeDef): ViewField[] {
  return (def.fields ?? []).map((f) => {
    const [fname, fdef] = entryOf<DatasourceFieldDef>(f);
    const out: ViewField = {
      name: fname,
      rawType: fdef.type,
      parsed: parseFieldType(fdef.type),
      isNullable: fdef.is_nullable === true,
    };
    if (typeof fdef.size === "number") out.size = fdef.size;
    if (Object.prototype.hasOwnProperty.call(fdef, "default_value")) {
      out.default_value = fdef.default_value;
    }
    return out;
  });
}

interface OmitContext {
  datasourceData: DatasourceDoc | null | undefined;
  inheritsName: string;
}

function omitSetForView(
  def: RawTypeDef,
  dsDef: RawTypeDef,
  ctx: OmitContext,
): Set<string> {
  const omitSet = new Set<string>([
    ...(Array.isArray(def.omit) ? def.omit : []),
    ...(Array.isArray(def.__omitFromInherited) ? def.__omitFromInherited : []),
  ]);
  if (dsDef.datasource_type === "readonly-lookup") {
    omitSet.add("uuid");
    omitSet.add("created");
    omitSet.add("updated");
  }
  if (hasCustomPrimaryKey(dsDef)) {
    const declared = declaredFieldNames(dsDef);
    const mapped = mappedLogicalFieldNames(
      ctx.datasourceData,
      ctx.inheritsName,
    );
    for (const std of ["id", "uuid", "created", "updated"]) {
      if (!declared.has(std) && !mapped.has(std)) omitSet.add(std);
    }
  }
  return omitSet;
}

interface ViewComponentContext {
  dsByName: Map<string, DsTypeDef>;
  datasourceData: DatasourceDoc | null | undefined;
  ds: DatasourceSettings;
}

/** The base schema for one view (before `__enrichments` are applied): a `one_of` union, an inherited datasource shape, or a fields-only DTO. `ctx` = { dsByName, datasourceData }. */
function buildViewComponent(
  viewName: string,
  def: RawTypeDef,
  ctx: ViewComponentContext,
): OpenApiSchema {
  if (Array.isArray(def.one_of)) {
    return {
      oneOf: def.one_of.map((m) => ({ $ref: `#/components/schemas/${m}` })),
    };
  }
  const inheritsName = def.inherits
    ? def.inherits.slice("datasource_types.".length)
    : null;
  const viewFields = toViewFields(def);
  const dsDef = inheritsName ? ctx.dsByName.get(inheritsName) : null;
  if (!dsDef) return buildDtoSchema(viewFields);
  const omitSet = omitSetForView(def, dsDef, {
    datasourceData: ctx.datasourceData,
    inheritsName: inheritsName!,
  });
  return buildSchemaForView(dsDef, viewFields, {
    omitSet,
    includeRequired: isWriteDtoViewName(viewName),
    ds: ctx.ds,
  });
}

export function buildComponents(
  viewData: RawTypesDoc,
  datasourceData: RawTypesDoc,
  ds: DatasourceSettings = DEFAULT_DS,
): Record<string, OpenApiSchema> {
  const dsByName = indexDatasourceTypes(datasourceData);
  const expanded = expandViewTypes(viewData, datasourceData);
  const ctx: ViewComponentContext = { dsByName, datasourceData, ds };
  const components: Record<string, OpenApiSchema> = {};
  for (const entry of expanded.types) {
    const [viewName, def] = entryOf(entry);
    components[viewName] = buildViewComponent(viewName, def, ctx);
    applyEnrichmentNames(components[viewName], def, dsByName);
  }
  return components;
}

const REF_PREFIX = "#/components/schemas/";
const MAX_REF_REVISITS = 1;
const MAX_DEPTH = 32;

type Template =
  | string
  | number
  | boolean
  | null
  | Template[]
  | { [key: string]: Template };

interface WalkCursor {
  refStack: string[];
  depth: number;
}

export function schemaToTemplate(
  schema: OpenApiSchema,
  options: { components?: Record<string, OpenApiSchema> } = {},
): Template {
  const components = options.components ?? {};
  return walk(schema, components, { refStack: [], depth: 0 });
}

function walkRef(
  schema: OpenApiSchema,
  components: Record<string, OpenApiSchema>,
  cursor: WalkCursor,
): Template {
  const ref = schema.$ref!;
  if (!ref.startsWith(REF_PREFIX)) return null;
  const name = ref.slice(REF_PREFIX.length);
  let seenCount = 0;
  for (const prior of cursor.refStack) if (prior === name) seenCount++;
  if (seenCount > MAX_REF_REVISITS) return name;
  const target = components[name];
  if (!target) return name;
  return walk(target, components, {
    refStack: [...cursor.refStack, name],
    depth: cursor.depth + 1,
  });
}

function walkAllOf(
  parts: OpenApiSchema[],
  components: Record<string, OpenApiSchema>,
  cursor: WalkCursor,
): Template {
  const merged: Record<string, Template> = {};
  for (const part of parts) {
    const piece = walk(part, components, cursor);
    if (piece && typeof piece === "object" && !Array.isArray(piece)) {
      Object.assign(merged, piece);
    }
  }
  return merged;
}

function walkObject(
  schema: OpenApiSchema,
  components: Record<string, OpenApiSchema>,
  cursor: WalkCursor,
): Template {
  const props = schema.properties ?? {};
  const out: Record<string, Template> = {};
  for (const [key, sub] of Object.entries(props)) {
    out[key] = walk(sub, components, {
      refStack: cursor.refStack,
      depth: cursor.depth + 1,
    });
  }
  return out;
}

function scalarTemplate(schema: OpenApiSchema): Template {
  if (
    schema.type !== "string" &&
    schema.type !== "integer" &&
    schema.type !== "number" &&
    schema.type !== "boolean"
  ) {
    return null;
  }
  return SAMPLE_CONVERTER.templateSample(
    converterTypeForSchema(schema),
  ) as Template;
}

function walk(
  schema: OpenApiSchema,
  components: Record<string, OpenApiSchema>,
  cursor: WalkCursor,
): Template {
  const { refStack, depth } = cursor;
  if (!schema || typeof schema !== "object") return null;
  if (depth > MAX_DEPTH) return null;
  if (typeof schema.$ref === "string")
    return walkRef(schema, components, cursor);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return walk(schema.oneOf[0], components, cursor);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return walk(schema.anyOf[0], components, cursor);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return walkAllOf(schema.allOf, components, cursor);
  }
  if (schema.type === "array") {
    return [
      walk(schema.items ?? {}, components, { refStack, depth: depth + 1 }),
    ];
  }
  if (schema.type === "object" || schema.properties) {
    return walkObject(schema, components, cursor);
  }
  return scalarTemplate(schema);
}
