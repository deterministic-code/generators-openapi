import npmPluralize from "pluralize";
import {
  expandViewTypes,
  routeViewTypeDirective,
} from "./view-expand.ts";
import { camelCase, pascalCase } from "change-case";
import { kebabPlural } from "./case.ts";
import type {
  RawFieldEntry,
  RawTypeDef,
  RawTypeEntry,
  RawTypesDoc,
  RawIncludeEntry,
} from "./deterministic-shapes.ts";
import type { JsonValue } from "./case.ts";
import { compileRoutesFilter } from "../common/compile-filter.ts";
import type { FilterPredicate } from "../common/compile-filter.ts";
import { indexDatasourceByName } from "./datasource-index.ts";
import { iterateCombinedRoutes } from "./combined-routes-core.ts";
import { buildComponents, schemaToTemplate } from "./schema-build.ts";
import { DatasourceSettings } from "./datasource-settings.ts";
import { parseByFieldEntry } from "./by-field-discovery.ts";

export { iterateCombinedRoutes };

/** A resolved request/response body reference — its component name, the `$ref` schema, and a rendered example. */
interface BodyShape {
  name: string;
  schema: { $ref: string } | null;
  example: JsonValue | null;
}

/** One generated route definition body, keyed by route name in a `RouteEntry`. `request`/`response` start as component-name strings and become `BodyShape`s after body augmentation. */
interface RouteDef {
  path?: string;
  method?: string;
  request?: string | BodyShape;
  response?: string | BodyShape;
  entity?: string | null;
  isCustom?: boolean;
  byField?: string;
  byFieldUnique?: boolean;
  primaryKeyField?: string | null;
}

/** A single route entry `{ routeName: def }`. */
type RouteEntry = Record<string, RouteDef>;

/** An item in the flat route list — an generated `RouteEntry`, or a raw authored/custom entry passed through verbatim (any JSON value). */
type RouteListItem = RouteEntry | JsonValue;

/** The `entity`/`isCustom` (and optional pk/by-field) metadata spread onto every generated route def. */
interface RouteMeta {
  entity: string;
  isCustom: boolean;
  primaryKeyField?: string | null;
  byField?: string;
  byFieldUnique?: boolean;
}

/** The OpenAPI component map `buildComponents` produces, reused for the m2m link-body delta. */
type ComponentMap = ReturnType<typeof buildComponents>;

/** One index definition inside a datasource type's `indexes` list. */
interface DsIndexDef {
  is_unique?: boolean;
  fields?: string[];
}
type DsIndexEntry = Record<string, DsIndexDef | null>;

/** A datasource type def as walked here — `RawTypeDef` plus the `target` surface tag and `indexes` this module reads. */
interface DatasourceTypeDef extends RawTypeDef {
  target?: string;
  indexes?: DsIndexEntry[];
}

type DatasourceIndex = Map<string, DatasourceTypeDef>;

/** A `combined_types` child override map `{ via, target, route }`. Keys stay in wire casing. */
interface CombinedChildDef {
  via?: string;
  target?: string;
  route?: string;
}
type CombinedChildEntry = string | Record<string, CombinedChildDef>;

/** One `combined_routes` parent body: its `route` template plus the ordered `combined_types` children. */
interface CombinedRouteDef {
  route?: string;
  combined_types?: CombinedChildEntry[];
}
type CombinedRouteEntry = Record<string, CombinedRouteDef>;

/** A parsed routes doc: explicit `routes`, `combined_routes`, and the `includes` directive list. */
interface RoutesDoc {
  routes?: JsonValue[];
  combined_routes?: CombinedRouteEntry[];
  includes?: RawIncludeEntry[];
}

/** The `view_type_routes` directive body this module reads — its filter DSL plus the eager-write path list. */
interface ViewTypeRoutesBlock {
  filter?: string;
  eager_write_path?: JsonValue[];
}

/** A datasource-backed view narrowed to what routing decisions need — its name, kind, inheritance namespace, datasource type tag, route-surface target, and custom pk. */
interface ViewTypeCandidate {
  name: string;
  kind: string;
  inheritsNamespace: string;
  datasourceType: string;
  target: string;
  primaryKeyField: string | null;
}

/** The `expandViewTypes` result — the ordered list of expanded view-type entries. */
interface ExpandedViewData {
  types: RawTypeEntry[];
}

/** The `expandRoutes` result — the flat route list plus the OpenAPI component map. */
export interface ExpandedRoutes {
  routes: RouteListItem[];
  components: ComponentMap;
}

/** The descriptor union `iterateCombinedRoutes` yields, recovered from its generator return. */
type CombinedRouteDescriptor =
  ReturnType<typeof iterateCombinedRoutes> extends Generator<infer T>
    ? T
    : never;
type DirectFkDescriptor = Extract<
  CombinedRouteDescriptor,
  { kind: "direct-fk" }
>;
type M2mDescriptor = Extract<CombinedRouteDescriptor, { kind: "m2m" }>;

// target: None = no public API surface (internal sinks / no-PK fixtures) — any CRUD route would be unanswerable at runtime.
export function hasNoRouteSurface(
  candidate: { target?: string } | null | undefined,
): boolean {
  return candidate?.target === "None";
}

function singularizeWord(word: string): string {
  return npmPluralize.singular(word);
}

interface VerbEntitySuffix {
  suffix: string;
  verb: string;
  multiplicity: "single" | "many";
  trail?: string;
}

const VERB_ENTITY_SUFFIXES: VerbEntitySuffix[] = [
  {
    suffix: "LinkByBody",
    verb: "link",
    multiplicity: "single",
    trail: "ByBody",
  },
  { suffix: "Unlink", verb: "unlink", multiplicity: "single" },
  { suffix: "Link", verb: "link", multiplicity: "single" },
  { suffix: "List", verb: "get", multiplicity: "many" },
  { suffix: "Create", verb: "create", multiplicity: "single" },
  { suffix: "Update", verb: "update", multiplicity: "single" },
  { suffix: "Delete", verb: "delete", multiplicity: "single" },
  { suffix: "Get", verb: "get", multiplicity: "single" },
];

function transformEntityTail(entity: string, multiplicity: string): string {
  const m = entity.match(/^(.*?)([A-Z][a-z]*|[a-z]+)$/);
  if (!m) return entity;
  const [, head, tail] = m;
  const lower = tail.toLowerCase();
  const singular = singularizeWord(lower);
  const finalLower = multiplicity === "many" ? npmPluralize.plural(singular) : singular;
  const isCap = tail[0] === tail[0].toUpperCase();
  const cased = isCap
    ? finalLower.charAt(0).toUpperCase() + finalLower.slice(1)
    : finalLower;
  return head + cased;
}

export function toVerbEntity(name: string): string {
  if (typeof name !== "string" || !name) return name;
  for (const {
    suffix,
    verb,
    multiplicity,
    trail = "",
  } of VERB_ENTITY_SUFFIXES) {
    if (name.length <= suffix.length || !name.endsWith(suffix)) continue;
    const entity = transformEntityTail(
      name.slice(0, -suffix.length),
      multiplicity,
    );
    const pascal = entity.charAt(0).toUpperCase() + entity.slice(1);
    return `${verb}${pascal}${trail}`;
  }
  return name;
}

export function toDisplayTitle(name: string): string {
  if (typeof name !== "string" || !name) return name;
  const verbEntity = toVerbEntity(name);
  const spaced = verbEntity
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function toPathGroupTag(openApiPath: string): string | null {
  if (typeof openApiPath !== "string" || !openApiPath) return null;
  const segments = openApiPath.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0] !== "api") return null;
  const head = segments[1];
  if (head.startsWith("{")) return null;
  return head
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function applyVerbEntityNaming(
  expanded: ExpandedRoutes,
): ExpandedRoutes {
  const routes = Array.isArray(expanded?.routes) ? expanded.routes : [];
  return {
    ...expanded,
    routes: routes.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const out: RouteEntry = {};
      for (const [key, value] of Object.entries(entry)) {
        out[toVerbEntity(key)] = value as RouteDef;
      }
      return out;
    }),
  };
}

const BY_FIELD_METHODS_DEFAULT = ["GET", "PUT", "DELETE"];

/** The minimal field-def flags `columnIsUnique` inspects. Structural so external callers passing their own looser field-def shape satisfy it. */
interface UniqueFieldFlags {
  primary_key?: boolean;
  is_unique?: boolean;
}

/** The minimal datasource-def surface `columnIsUnique` reads — field flags plus the unique-index list. */
interface UniqueColumnSource {
  fields?: Record<string, UniqueFieldFlags>[];
  indexes?: DsIndexEntry[];
}

function findDatasourceFieldDef(
  datasource: UniqueColumnSource,
  columnName: string,
): UniqueFieldFlags | null {
  for (const fieldObj of datasource?.fields ?? []) {
    if (columnName in fieldObj) return fieldObj[columnName];
  }
  return null;
}

export function columnIsUnique(
  datasource: UniqueColumnSource,
  columnName: string,
): boolean {
  if (columnName === "id") return true;
  const fieldDef = findDatasourceFieldDef(datasource, columnName);
  if (
    fieldDef &&
    (fieldDef.primary_key === true || fieldDef.is_unique === true)
  ) {
    return true;
  }
  const indexes = Array.isArray(datasource?.indexes) ? datasource.indexes : [];
  for (const indexEntry of indexes) {
    const indexDef = Object.values(indexEntry)[0];
    if (!indexDef || indexDef.is_unique !== true) continue;
    const fields = Array.isArray(indexDef.fields) ? indexDef.fields : [];
    if (fields.length === 1 && fields[0] === columnName) return true;
  }
  return false;
}

function resolveEntityDatasource(
  entityName: string,
  expandedViewData: ExpandedViewData,
  datasourceByName: DatasourceIndex,
): { name: string; def: DatasourceTypeDef | undefined } | null {
  const types = expandedViewData.types;
  for (const entry of types) {
    const [name, def] = Object.entries(entry)[0];
    if (name !== entityName) continue;
    const inherits = typeof def?.inherits === "string" ? def.inherits : "";
    if (!inherits.startsWith("datasource_types.")) return null;
    const dsName = inherits.slice("datasource_types.".length);
    return { name: dsName, def: datasourceByName.get(dsName) };
  }
  return null;
}

interface ByFieldRouteDef {
  entity: string;
  byField: string;
  methods?: string[];
}

interface ByFieldRouteContext {
  camel: string;
  byFieldPascal: string;
  memberPath: string;
  entity: string;
  meta: RouteMeta;
}

function byFieldMethodRoutes(
  ctx: ByFieldRouteContext,
  requestedMethods: string[],
): RouteEntry[] {
  const { camel, byFieldPascal, memberPath, entity, meta } = ctx;
  const out: RouteEntry[] = [];
  if (requestedMethods.includes("GET")) {
    out.push({
      [`${camel}GetBy${byFieldPascal}`]: {
        path: memberPath,
        method: "GET",
        response: entity,
        ...meta,
      },
    });
  }
  if (requestedMethods.includes("PUT")) {
    out.push({
      [`${camel}UpdateBy${byFieldPascal}`]: {
        path: memberPath,
        method: "PUT",
        request: `update_${entity}`,
        response: entity,
        ...meta,
      },
    });
  }
  if (requestedMethods.includes("DELETE")) {
    out.push({
      [`${camel}DeleteBy${byFieldPascal}`]: {
        path: memberPath,
        method: "DELETE",
        ...meta,
      },
    });
  }
  return out;
}

function expandByFieldRoute(
  def: ByFieldRouteDef,
  expandedViewData: ExpandedViewData,
  datasourceByName: DatasourceIndex,
): RouteEntry[] {
  const entity = def.entity;
  const byField = def.byField;
  const requestedMethods = Array.isArray(def.methods)
    ? def.methods
    : BY_FIELD_METHODS_DEFAULT;
  const datasourceInfo = resolveEntityDatasource(
    entity,
    expandedViewData,
    datasourceByName,
  );
  const unique = datasourceInfo?.def
    ? columnIsUnique(datasourceInfo.def, byField)
    : false;

  const collection = `/api/${kebabPlural(entity)}/${byField.replace(/_/g, "-")}`;
  const memberPath = `${collection}/:${camelCase(byField)}`;
  const meta: RouteMeta = {
    entity,
    isCustom: false,
    byField,
    byFieldUnique: unique,
  };

  return byFieldMethodRoutes(
    {
      camel: camelCase(entity),
      byFieldPascal: pascalCase(byField),
      memberPath,
      entity,
      meta,
    },
    requestedMethods,
  );
}

/** Validate one `{ name: def }` field slot and return its name when it's a non-id declared primary key, else null. Throws on a malformed slot. */
function customPrimaryKeyFieldName(
  entry: RawFieldEntry,
  i: number,
): string | null {
  if (entry === null || typeof entry !== "object") {
    throw new Error(
      `datasource_types[*].fields[${i}] must be a single-key field map, got ${typeof entry}`,
    );
  }
  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    throw new Error(
      `datasource_types[*].fields[${i}] must have exactly one key (got ${keys.length})`,
    );
  }
  const fieldName = keys[0];
  const fieldDef = entry[fieldName];
  if (fieldDef === null || typeof fieldDef !== "object") {
    throw new Error(
      `datasource_types[*].fields[${i}].${fieldName} must be an object`,
    );
  }
  return fieldDef.primary_key === true && fieldName !== "id" ? fieldName : null;
}

// Returns the YAML-declared `primary_key: true` field name (non-id) or null.
function findCustomPrimaryKeyField(
  def: DatasourceTypeDef | undefined,
): string | null {
  if (def === undefined || def === null) return null;
  if (typeof def !== "object") {
    throw new Error(
      `findCustomPrimaryKeyField: expected datasource def object, got ${typeof def}`,
    );
  }
  const fields = def.fields;
  if (fields === undefined) return null;
  if (!Array.isArray(fields)) {
    throw new Error(
      `datasource_types[*].fields must be a list, got ${typeof fields}`,
    );
  }
  for (let i = 0; i < fields.length; i++) {
    const fieldName = customPrimaryKeyFieldName(fields[i], i);
    if (fieldName !== null) return fieldName;
  }
  return null;
}

function viewTypeCandidate(
  viewEntry: RawTypeEntry,
  datasourceByName: DatasourceIndex,
): ViewTypeCandidate {
  const [name, def] = Object.entries(viewEntry)[0];
  const inherits = def && typeof def.inherits === "string" ? def.inherits : "";
  let inheritsNamespace = "";
  let datasourceType = "";
  let target = "StandardCrud";
  let primaryKeyField: string | null = null;
  if (inherits.startsWith("datasource_types.")) {
    inheritsNamespace = "datasource_types";
    const parentName = inherits.slice("datasource_types.".length);
    const parent = datasourceByName.get(parentName);
    if (parent && typeof parent.datasource_type === "string") {
      datasourceType = parent.datasource_type;
    }
    if (parent && typeof parent.target === "string") {
      target = parent.target;
    }
    primaryKeyField = findCustomPrimaryKeyField(parent);
  }
  const kind =
    inheritsNamespace === "datasource_types" ? "datasource_type" : "view_type";
  return {
    name,
    kind,
    inheritsNamespace,
    datasourceType,
    target,
    primaryKeyField,
  };
}

function isReadonlyLookup(candidate: ViewTypeCandidate): boolean {
  return candidate.datasourceType === "readonly-lookup";
}

interface BuildCrudOptions {
  entity: string;
  collectionPath: string;
  memberPath: string;
  isReadonly: boolean;
  meta: RouteMeta;
  writeRequestPost: string;
  writeRequestPut: string;
  patchRequest: string;
}

function buildCrudRoutes(o: BuildCrudOptions): RouteEntry[] {
  const camel = camelCase(o.entity);
  const base = { response: o.entity, ...o.meta };
  const routes: RouteEntry[] = [
    { [`${camel}List`]: { path: o.collectionPath, method: "GET", ...base } },
    { [`${camel}Get`]: { path: o.memberPath, method: "GET", ...base } },
  ];
  if (o.isReadonly) return routes;
  routes.push({
    [`${camel}Create`]: {
      path: o.collectionPath,
      method: "POST",
      request: o.writeRequestPost,
      ...base,
    },
  });
  routes.push({
    [`${camel}Update`]: {
      path: o.memberPath,
      method: "PUT",
      request: o.writeRequestPut,
      ...base,
    },
  });
  routes.push({
    [`${camel}Patch`]: {
      path: o.memberPath,
      method: "PATCH",
      request: o.patchRequest,
      ...base,
    },
  });
  routes.push({
    [`${camel}Delete`]: { path: o.memberPath, method: "DELETE", ...o.meta },
  });
  return routes;
}

function crudRoutesForViewType(
  candidate: ViewTypeCandidate,
  eagerWriteSet: Set<string>,
): RouteEntry[] {
  const viewName = candidate.name;
  const collectionPath = `/api/${kebabPlural(viewName)}`;
  const pkParam = candidate.primaryKeyField ?? "id";
  const isEager = eagerWriteSet && eagerWriteSet.has(viewName);
  return buildCrudRoutes({
    entity: viewName,
    collectionPath,
    memberPath: `${collectionPath}/:${pkParam}`,
    isReadonly: isReadonlyLookup(candidate),
    meta: {
      entity: viewName,
      isCustom: false,
      primaryKeyField: candidate.primaryKeyField ?? null,
    },
    writeRequestPost: isEager
      ? `${viewName}_eager_create_body`
      : candidate.primaryKeyField
        ? `create_${viewName}`
        : `update_${viewName}`,
    writeRequestPut: isEager ? `${viewName}_eager_body` : `update_${viewName}`,
    patchRequest: isEager
      ? `${viewName}_eager_patch_body`
      : `update_${viewName}`,
  });
}

function viewTypeRoutesBlock(
  routesData: RoutesDoc,
): ViewTypeRoutesBlock | null {
  return routeViewTypeDirective(routesData) as ViewTypeRoutesBlock | null;
}

function collectEagerWriteRoots(routesData: RoutesDoc): Set<string> {
  const out = new Set<string>();
  const paths = viewTypeRoutesBlock(routesData)?.eager_write_path;
  if (!Array.isArray(paths)) return out;
  for (const p of paths) {
    const segments = String(p).split(".");
    if (segments.length === 2 && segments[0]) out.add(segments[0]);
  }
  return out;
}

const EAGER_DERIVED_SUFFIXES = [
  "_eager_body",
  "_eager_create_body",
  "_eager_patch_body",
  "_eager_row",
  "_eager_create_row",
];

function isEagerDerivedName(name: string): boolean {
  return EAGER_DERIVED_SUFFIXES.some((s) => name.endsWith(s));
}

interface RoutableFilterContext {
  predicate: FilterPredicate;
  childrenOnly?: Set<string>;
  combinedParents?: Set<string>;
}

/** A candidate is routable when it's a real datasource-backed view (not an update_/create_/eager_ derivative, not surface-less) that passes the filter and isn't already owned by a combined-route parent/child. */
function isRoutableCandidate(
  candidate: ViewTypeCandidate,
  { predicate, childrenOnly, combinedParents }: RoutableFilterContext,
): boolean {
  const name = candidate.name;
  if (name.startsWith("update_") || name.startsWith("create_")) return false;
  if (isEagerDerivedName(name)) return false;
  if (candidate.inheritsNamespace !== "datasource_types") return false;
  if (hasNoRouteSurface(candidate)) return false;
  if (!predicate(candidate)) return false;
  if (childrenOnly?.has(name)) return false;
  if (combinedParents?.has(name)) return false;
  return true;
}

interface ViewTypeRouteContext {
  datasourceByName: DatasourceIndex;
  childrenOnly: Set<string>;
  combinedParents: Set<string>;
}

function expandViewTypeRoutes(
  routesData: RoutesDoc,
  expandedViewData: ExpandedViewData,
  ctx: ViewTypeRouteContext,
): RouteEntry[] {
  const { datasourceByName, childrenOnly, combinedParents } = ctx;
  const block = viewTypeRoutesBlock(routesData);
  if (!block) return [];

  const predicate = compileRoutesFilter(block.filter);
  const eagerWriteSet = collectEagerWriteRoots(routesData);
  const survivors = expandedViewData.types
    .map((entry) => viewTypeCandidate(entry, datasourceByName))
    .filter((c) =>
      isRoutableCandidate(c, { predicate, childrenOnly, combinedParents }),
    );

  survivors.sort((a, b) => a.name.localeCompare(b.name));
  return survivors.flatMap((c) => crudRoutesForViewType(c, eagerWriteSet));
}

export function collectCombinedChildNames(
  routesData: RoutesDoc,
  datasourceByName: DatasourceIndex,
): Set<string> {
  const childrenOnly = new Set<string>();
  const parents = new Set<string>();

  for (const entry of routesData.combined_routes ?? []) {
    const [parent] = Object.entries(entry)[0];
    parents.add(parent);
  }

  for (const entry of routesData.combined_routes ?? []) {
    const [parentName, def] = Object.entries(entry)[0];
    for (const child of def.combined_types ?? []) {
      let childName: string;
      if (typeof child === "string") {
        childName = child.replace(/-/g, "_");
      } else {
        const [rawName, childDef] = Object.entries(child)[0];
        // why skip m2m: explicit via:/target: routes through a junction; standalone routes must stay generatetable.
        if (childDef && (childDef.via || childDef.target)) continue;
        childName = rawName.replace(/-/g, "_");
      }

      if (parents.has(childName)) continue;
      if (
        datasourceByName &&
        hasFkTo(datasourceByName, childName, parentName)
      ) {
        childrenOnly.add(childName);
      }
    }
  }

  return childrenOnly;
}

function hasFkTo(
  datasourceByName: DatasourceIndex,
  childName: string,
  parentName: string,
): boolean {
  const def = datasourceByName.get(childName);
  if (!def) return false;
  const target = `${parentName}.id`;
  return (def.fields ?? []).some((f) => {
    const [, fieldDef] = Object.entries(f)[0];
    return fieldDef?.references === target;
  });
}

function segmentPascal(segmentTail: string): string {
  return pascalCase(segmentTail.replace(/-/g, "_"));
}

function combinedRouteParentDescriptors(
  routesData: RoutesDoc,
): Map<string, string> {
  const seen = new Map<string, string>();
  for (const entry of routesData.combined_routes ?? []) {
    const [parentName, def] = Object.entries(entry)[0];
    if (typeof def?.route !== "string") continue;
    if (seen.has(parentName)) continue;
    seen.set(parentName, def.route);
  }
  return seen;
}

function generateParentCrudRoutes(
  [parentName, parentRoute]: [string, string],
  datasourceByName: DatasourceIndex,
  eagerWriteSet: Set<string>,
): RouteEntry[] {
  const parentDef = datasourceByName.get(parentName);
  if (!parentDef) return [];
  if (parentDef.datasource_type === "many-to-many") return [];

  const memberPath = parentRoute.replace(/\{id\}/g, ":id");
  const collectionPath = memberPath.replace(/\/:id$/, "");
  if (collectionPath === memberPath) return [];

  const isEager = eagerWriteSet && eagerWriteSet.has(parentName);
  return buildCrudRoutes({
    entity: parentName,
    collectionPath,
    memberPath,
    isReadonly: parentDef.datasource_type === "readonly-lookup",
    meta: { entity: parentName, isCustom: false },
    writeRequestPost: isEager
      ? `${parentName}_eager_create_body`
      : `update_${parentName}`,
    writeRequestPut: isEager
      ? `${parentName}_eager_body`
      : `update_${parentName}`,
    patchRequest: isEager
      ? `${parentName}_eager_patch_body`
      : `update_${parentName}`,
  });
}

function combinedRoutePrefix(descriptor: {
  parent: string;
  segmentTail: string;
}): string {
  return (
    camelCase(descriptor.parent) + segmentPascal(descriptor.segmentTail)
  );
}

function directFkCombinedRoutes(descriptor: DirectFkDescriptor): RouteEntry[] {
  const prefix = combinedRoutePrefix(descriptor);
  const child = descriptor.child.name;
  const meta: RouteMeta = { entity: child, isCustom: false };
  return [
    {
      [`${prefix}List`]: {
        path: descriptor.collectionPath,
        method: "GET",
        response: child,
        ...meta,
      },
    },
    {
      [`${prefix}Create`]: {
        path: descriptor.collectionPath,
        method: "POST",
        request: `update_${child}`,
        response: child,
        ...meta,
      },
    },
    {
      [`${prefix}Update`]: {
        path: descriptor.memberPath,
        method: "PUT",
        request: `update_${child}`,
        response: child,
        ...meta,
      },
    },
    {
      [`${prefix}Delete`]: {
        path: descriptor.memberPath,
        method: "DELETE",
        ...meta,
      },
    },
  ];
}

/** The `link_<junction>` request schema `{ <child>_id: <parent id type> }` — mountCombinedRoutes.ts wires bodyFields:[childFkField], and the property takes the referenced parent's id schema so a uuid parent isn't declared as integer. Registered so the LinkByBody POST $ref resolves. */
function m2mLinkComponent(
  descriptor: M2mDescriptor,
  ds: DatasourceSettings,
): ComponentMap {
  const targetFkField = descriptor.childFkField;
  return {
    [`link_${descriptor.junction}`]: {
      type: "object",
      required: [targetFkField],
      properties: {
        [targetFkField]: {
          ...ds.openApiIdSchema(),
          "x-references": `${descriptor.target}.id`,
        },
      },
    },
  };
}

function m2mCombinedRoutes(
  descriptor: M2mDescriptor,
  ds: DatasourceSettings,
): { routes: RouteEntry[]; componentDelta: ComponentMap } {
  const prefix = combinedRoutePrefix(descriptor);
  const target = descriptor.target;
  const meta: RouteMeta = { entity: target, isCustom: false };
  const componentDelta = m2mLinkComponent(descriptor, ds);
  const routes: RouteEntry[] = [
    {
      [`${prefix}List`]: {
        path: descriptor.collectionPath,
        method: "GET",
        response: target,
        ...meta,
      },
    },
    {
      [`${prefix}LinkByBody`]: {
        path: descriptor.collectionPath,
        method: "POST",
        request: `link_${descriptor.junction}`,
        response: target,
        ...meta,
      },
    },
    {
      [`${prefix}Get`]: {
        path: descriptor.memberPath,
        method: "GET",
        response: target,
        ...meta,
      },
    },
    {
      [`${prefix}Link`]: {
        path: descriptor.memberPath,
        method: "POST",
        response: target,
        ...meta,
      },
    },
    {
      [`${prefix}Unlink`]: {
        path: descriptor.memberPath,
        method: "DELETE",
        ...meta,
      },
    },
  ];
  return { routes, componentDelta };
}

function expandCombinedRoutes(
  routesData: RoutesDoc,
  datasourceData: RawTypesDoc,
  ds: DatasourceSettings | undefined,
): { routes: RouteEntry[]; componentDelta: ComponentMap } {
  const settings = ds ?? new DatasourceSettings();
  const out: RouteEntry[] = [];
  const componentDelta: ComponentMap = {};
  const datasourceByName = indexDatasourceByName(
    datasourceData,
  ) as DatasourceIndex;
  const eagerWriteSet = collectEagerWriteRoots(routesData);

  for (const parent of combinedRouteParentDescriptors(routesData)) {
    out.push(...generateParentCrudRoutes(parent, datasourceByName, eagerWriteSet));
  }

  for (const descriptor of iterateCombinedRoutes({
    routesData,
    datasourceData,
  })) {
    if (descriptor.kind === "direct-fk") {
      out.push(...directFkCombinedRoutes(descriptor));
    } else if (descriptor.kind === "m2m") {
      const { routes, componentDelta: delta } = m2mCombinedRoutes(
        descriptor,
        settings,
      );
      out.push(...routes);
      Object.assign(componentDelta, delta);
    }
  }

  return { routes: out, componentDelta };
}

export function formatEndpointsList(expanded: ExpandedRoutes): string {
  const routes = Array.isArray(expanded?.routes) ? expanded.routes : [];
  const rows = routes
    .map((entry) => {
      const def = Object.values(entry as RouteEntry)[0];
      if (!def || typeof def !== "object") return null;
      const method =
        typeof def.method === "string" ? def.method.toUpperCase() : null;
      const path = typeof def.path === "string" ? def.path : null;
      if (!method || !path) return null;
      return { method, path };
    })
    .filter((r): r is { method: string; path: string } => Boolean(r));

  return rows.map((r) => `${r.method} ${r.path}`).join("\n") + "\n";
}

function resolveBodyShape(
  name: string,
  components: ComponentMap,
): BodyShape | undefined {
  if (!name || typeof name !== "string") return undefined;
  if (!components || typeof components !== "object" || !components[name]) {
    return { name, schema: null, example: null };
  }
  const schema = { $ref: `#/components/schemas/${name}` };
  const example = schemaToTemplate(schema, { components });
  return { name, schema, example };
}

interface BuildCustomRoutesOptions {
  entries: JsonValue[];
  datasourceData: RawTypesDoc;
  expandedViewData: ExpandedViewData;
  datasourceByName: DatasourceIndex;
}

/** Expand the explicit `routes:` entries: byField string/object shorthands fan out to per-method routes; every other entry is tagged custom (entity:null). */
function buildCustomRoutes({
  entries,
  datasourceData,
  expandedViewData,
  datasourceByName,
}: BuildCustomRoutesOptions): RouteListItem[] {
  const customRoutes: RouteListItem[] = [];
  for (const entry of entries) {
    const byField = parseByFieldEntry(entry, datasourceData);
    if (byField) {
      const expanded = expandByFieldRoute(
        {
          entity: byField.entity,
          byField: byField.byField,
          methods: byField.methods ?? undefined,
        },
        expandedViewData,
        datasourceByName,
      );
      for (const e of expanded) customRoutes.push(e);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      customRoutes.push(entry);
      continue;
    }
    const [name, def] = Object.entries(entry)[0];
    if (!def || typeof def !== "object") {
      customRoutes.push(entry);
      continue;
    }
    customRoutes.push({ [name]: { ...def, entity: null, isCustom: true } });
  }
  return customRoutes;
}

// Resolve each route's `request`/`response` string name to its body shape against the built components.
function augmentRouteBodies(
  allRoutes: RouteListItem[],
  components: ComponentMap,
): RouteListItem[] {
  return allRoutes.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const [routeName, routeDef] = Object.entries(entry)[0];
    if (!routeDef || typeof routeDef !== "object") return entry;

    const def = routeDef as RouteDef;
    const augmentedDef: RouteDef = { ...def };
    if (typeof def.request === "string") {
      augmentedDef.request = resolveBodyShape(def.request, components);
    }
    if (typeof def.response === "string") {
      augmentedDef.response = resolveBodyShape(def.response, components);
    }
    return { [routeName]: augmentedDef };
  });
}

interface ExpandRoutesOptions {
  routesData: RoutesDoc;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  componentProjection?: (viewData: RawTypesDoc) => RawTypesDoc;
  ds?: DatasourceSettings;
}

export function expandRoutes({
  routesData,
  viewData,
  datasourceData,
  componentProjection,
  ds,
}: ExpandRoutesOptions): ExpandedRoutes {
  const expandedViewData = expandViewTypes(viewData, datasourceData);
  const datasourceByName = indexDatasourceByName(
    datasourceData,
  ) as DatasourceIndex;

  const customRoutes = buildCustomRoutes({
    entries: Array.isArray(routesData.routes) ? routesData.routes : [],
    datasourceData,
    expandedViewData,
    datasourceByName,
  });
  const childrenOnly = collectCombinedChildNames(routesData, datasourceByName);
  const combinedParents = new Set(
    combinedRouteParentDescriptors(routesData).keys(),
  );
  const viewTypeRoutes = expandViewTypeRoutes(routesData, expandedViewData, {
    datasourceByName,
    childrenOnly,
    combinedParents,
  });
  const { routes: combinedRoutes, componentDelta } = expandCombinedRoutes(
    routesData,
    datasourceData,
    ds,
  );

  const allRoutes: RouteListItem[] = [
    ...customRoutes,
    ...viewTypeRoutes,
    ...combinedRoutes,
  ];

  const projectionFn =
    typeof componentProjection === "function"
      ? componentProjection
      : (viewData: RawTypesDoc) => viewData;
  const components = buildComponents(
    projectionFn(viewData),
    datasourceData,
    ds,
  );
  Object.assign(components, componentDelta);

  return { routes: augmentRouteBodies(allRoutes, components), components };
}
