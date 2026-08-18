import {
  expandRoutes,
  toVerbEntity,
  toDisplayTitle,
  toPathGroupTag,
} from "./routes-expand.ts";
import {
  deriveEagerWriteBodyTypes,
  projectViewTypesByEagerPath,
} from "./view-expand.ts";
import { buildWriteResponseSchema } from "./schema-build.ts";
import { optimisticConcurrencyByEntity } from "../common/parse-routes.ts";
import { DatasourceSettings } from "./datasource-settings.ts";

const lastSegmentIsParam = (path: string): boolean => {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1];
  return last.startsWith("{") && last.endsWith("}");
};

const DEFAULT_DS = new DatasourceSettings();
import { applySchemaNaming } from "./apply-schema-naming.ts";
import type { CaseFormat, JsonValue } from "./case.ts";
import {
  singleEntry,
  type RawIncludeEntry,
  type RawTypeDef,
  type RawTypesDoc,
} from "./deterministic-shapes.ts";

/** A datasource type def plus the migration/seed flags this builder reads (not on the base view-type shape). */
interface DsTypeDef extends RawTypeDef {
  skip_migrations?: boolean;
  seeds?: JsonValue[];
}

/** A minimal OpenAPI schema node — the subset this builder reads and writes. */
interface SchemaObject {
  type?: string;
  format?: string;
  $ref?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  "x-references"?: string;
}

/** A request/response body reference resolved by route expansion — its component name. */
interface SpecRouteBody {
  name: string;
}

/** The expanded/authored route surface this builder reads. */
interface SpecRoute {
  method: string;
  path: string;
  description?: string;
  isCustom?: boolean;
  responseFormat?: string;
  byField?: string;
  byFieldUnique?: boolean;
  request?: SpecRouteBody;
  response?: SpecRouteBody;
  entity?: string | null;
  targetEntity?: string;
  parentEntity?: string;
  service?: string;
  serviceMethod?: string;
  "x-implementation"?: string;
}

type SpecRouteEntry = Record<string, SpecRoute>;

/** One OpenAPI parameter — path params carry no description, the OCC header does. */
interface ParameterObject {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: SchemaObject;
}

type JsonBodyContent = Record<string, { schema: SchemaObject }>;

interface ResponseObject {
  description: string;
  content?: JsonBodyContent;
}

type ResponsesObject = Record<string, ResponseObject>;

interface RequestBodyObject {
  required: boolean;
  content: JsonBodyContent;
}

interface OperationObject {
  summary: string;
  operationId: string;
  tags?: string[];
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: ResponsesObject;
  "x-no-seeds"?: boolean;
  "x-implementation"?: string;
}

type PathsObject = Record<string, Record<string, OperationObject>>;

/** A datasource entity's declared non-standard primary key — column name and yaml type. */
interface PrimaryKeyType {
  column: string;
  type: string;
}

/** A routes document as consumed here — the flat `routes` list plus the `includes` directives. */
interface RoutesInputDoc {
  routes?: JsonValue[];
  includes?: RawIncludeEntry[];
}

type ComponentMap = Record<string, SchemaObject>;

interface ExpandedInput {
  routes: SpecRouteEntry[];
  components: ComponentMap;
}

/** The per-build context threaded through operation construction. */
interface BuildCtx {
  naming: string;
  groupByEntity: boolean;
  datasourceData: RawTypesDoc;
  ds: DatasourceSettings;
  useOptimisticConcurrency: boolean;
  occByEntity: Map<string, boolean>;
  unmountedCustomRouteNames: Set<string>;
  entitiesWithoutSeeds: Set<string>;
  primaryKeyTypesByEntity: Map<string, PrimaryKeyType>;
  writeResponseSchemas?: Map<string, SchemaObject>;
}

function pathFromExpressStyle(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function extractPathParams(openApiPath: string): string[] {
  const out: string[] = [];
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openApiPath)) !== null) out.push(m[1]);
  return out;
}

export function schemaForYamlType(
  yamlType: string | undefined,
): SchemaObject | null {
  switch (yamlType) {
    case "integer":
    case "smallinteger":
      return { type: "integer" };
    case "biginteger":
      return { type: "integer", format: "int64" };
    case "uuid":
      return { type: "string", format: "uuid" };
    case "string":
      return { type: "string" };
    default:
      return null;
  }
}

function pathParamSchema(
  name: string,
  yamlType: string | null,
  ds: DatasourceSettings = DEFAULT_DS,
): SchemaObject {
  if (yamlType) {
    const typed = schemaForYamlType(yamlType);
    if (typed) return typed;
  }
  if (name === "id" || /Id$/.test(name)) return ds.openApiIdSchema();
  return { type: "string" };
}

/** Map<entityName, { column, type }> from datasource_types.yaml — feeds pathParamSchema. */
export function collectPrimaryKeyTypesByEntity(
  datasourceData: RawTypesDoc,
): Map<string, PrimaryKeyType> {
  const out = new Map<string, PrimaryKeyType>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = singleEntry(entry);
    const fields = Array.isArray(def?.fields) ? def.fields : [];
    for (const fieldEntry of fields) {
      if (!fieldEntry || typeof fieldEntry !== "object") continue;
      const fieldKeys = Object.keys(fieldEntry);
      if (fieldKeys.length !== 1) continue;
      const fieldName = fieldKeys[0];
      const fieldDef = fieldEntry[fieldName];
      if (
        fieldDef &&
        fieldDef.primary_key === true &&
        typeof fieldDef.type === "string"
      ) {
        out.set(name, { column: fieldName, type: fieldDef.type });
        break;
      }
    }
  }
  return out;
}

function occHeaderParameter(
  useOptimisticConcurrency: boolean,
  method: string,
): ParameterObject | null {
  const isMutating =
    method === "PUT" || method === "PATCH" || method === "DELETE";
  if (!useOptimisticConcurrency || !isMutating) return null;
  return {
    name: "If-Match",
    in: "header",
    required: true,
    description:
      "Optimistic-concurrency token (the row's current `updated` timestamp). Required because the backend was generated with use_optimistic_concurrency=true.",
    schema: { type: "string" },
  };
}

function buildPathParameters(
  route: SpecRoute,
  openApiPath: string,
  ctx: BuildCtx,
): ParameterObject[] | undefined {
  const method = route.method.toUpperCase();
  const params = extractPathParams(openApiPath);
  const routeEntity = entityOfRoute(route);
  const occHeaderParam = occHeaderParameter(
    ctx.occByEntity.get(routeEntity ?? "") ?? ctx.useOptimisticConcurrency,
    method,
  );
  if (params.length === 0 && !occHeaderParam) return undefined;
  const routePk =
    routeEntity && ctx.primaryKeyTypesByEntity
      ? ctx.primaryKeyTypesByEntity.get(routeEntity)
      : null;
  const parameters = params.map((name): ParameterObject => {
    const yamlType = routePk && routePk.column === name ? routePk.type : null;
    return {
      name,
      in: "path",
      required: true,
      schema: pathParamSchema(name, yamlType, ctx.ds),
    };
  });
  if (occHeaderParam) parameters.push(occHeaderParam);
  return parameters;
}

function listResponseSchema(name: string): SchemaObject {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: { $ref: `#/components/schemas/${name}` } },
    },
  };
}

function namedResponseSchema(
  route: SpecRoute,
  openApiPath: string,
  ctx: BuildCtx,
): SchemaObject {
  const responseName = route.response!.name;
  const method = route.method.toUpperCase();
  const isByField = typeof route.byField === "string";
  const byFieldNonUnique = isByField && route.byFieldUnique !== true;
  const isList = route.isCustom
    ? route.responseFormat === "items"
    : (method === "GET" && !lastSegmentIsParam(openApiPath)) ||
      (method === "GET" && byFieldNonUnique);
  const isWrite = method === "POST" || method === "PUT" || method === "PATCH";
  const bareSchema =
    ctx.writeResponseSchemas && ctx.writeResponseSchemas.get(responseName);
  if (isList) return listResponseSchema(responseName);
  if (isWrite && byFieldNonUnique) return BYFIELD_COUNT_SCHEMA;
  if (isWrite && bareSchema) return bareSchema;
  return { $ref: `#/components/schemas/${responseName}` };
}

const BYFIELD_COUNT_SCHEMA: SchemaObject = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
};

const DELETE_RESULT_SCHEMA: SchemaObject = {
  type: "object",
  properties: { success: { type: "boolean" }, deleted: { type: "boolean" } },
};

const ERROR_RESPONSE_SCHEMA: SchemaObject = {
  type: "object",
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
      },
    },
  },
  required: ["errors"],
};

const jsonBody = (schema: SchemaObject): JsonBodyContent => ({
  "application/json": { schema },
});

const NOT_FOUND_RESPONSE: ResponseObject = {
  description: "Not Found",
  content: jsonBody(ERROR_RESPONSE_SCHEMA),
};

function deleteResponses(
  route: SpecRoute,
  byFieldNonUnique: boolean,
  isByField: boolean,
): ResponsesObject {
  // Generated deletes 404 when nothing matched; custom-route delete semantics are the author's, so leave them undocumented.
  const notFound: ResponsesObject = route.isCustom
    ? {}
    : { 404: NOT_FOUND_RESPONSE };
  if (byFieldNonUnique)
    return {
      200: { description: "OK", content: jsonBody(BYFIELD_COUNT_SCHEMA) },
      ...notFound,
    };
  if (isByField || route.isCustom)
    return { 204: { description: "No Content" }, ...notFound };
  // CRUD DELETE returns `{success:true}` (TS) or `{deleted:bool}` (Rust) at 200; schema lists both so e2e lockdown accepts either runtime.
  return {
    200: { description: "OK", content: jsonBody(DELETE_RESULT_SCHEMA) },
    ...notFound,
  };
}

function buildOperationResponses(
  route: SpecRoute,
  openApiPath: string,
  ctx: BuildCtx,
): ResponsesObject {
  const method = route.method.toUpperCase();
  const isByField = typeof route.byField === "string";
  const byFieldNonUnique = isByField && route.byFieldUnique !== true;
  if (method === "DELETE")
    return deleteResponses(route, byFieldNonUnique, isByField);
  // service-handled routes write a JSON body via sendItem; 204 mismatched the runtime.
  if (
    route.isCustom &&
    !route.response?.name &&
    route.responseFormat !== "raw"
  ) {
    const code = method === "POST" ? "201" : "200";
    return {
      [code]: {
        description: code === "201" ? "Created" : "OK",
        content: jsonBody({ type: "object" }),
      },
    };
  }
  if (route.response?.name) {
    const code = method === "POST" ? "201" : "200";
    return {
      [code]: {
        description: code === "201" ? "Created" : "OK",
        content: jsonBody(namedResponseSchema(route, openApiPath, ctx)),
      },
    };
  }
  return { 204: { description: "No Content" } };
}

function buildOperation(
  routeName: string,
  route: SpecRoute,
  ctx: BuildCtx,
): { method: string; openApiPath: string; op: OperationObject } {
  const method = route.method.toUpperCase();
  const openApiPath = pathFromExpressStyle(route.path);

  const operationId =
    ctx.naming === "verb-entity" ? toVerbEntity(routeName) : routeName;
  const op: OperationObject = {
    summary: toDisplayTitle(routeName),
    operationId,
  };
  if (ctx.groupByEntity) {
    const tag = toPathGroupTag(openApiPath);
    if (tag) op.tags = [tag];
  }
  if (route.description) op.description = route.description;

  const parameters = buildPathParameters(route, openApiPath, ctx);
  if (parameters) op.parameters = parameters;

  if (route.request?.name) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${route.request.name}` },
        },
      },
    };
  }

  op.responses = buildOperationResponses(route, openApiPath, ctx);

  if (
    ctx.entitiesWithoutSeeds &&
    typeof route.entity === "string" &&
    ctx.entitiesWithoutSeeds.has(route.entity)
  ) {
    op["x-no-seeds"] = true;
  }

  return { method: method.toLowerCase(), openApiPath, op };
}

function markStub(
  {
    op,
    routeName,
    route,
  }: { op: OperationObject; routeName: string; route: SpecRoute },
  ctx: BuildCtx,
): void {
  if (
    ctx.unmountedCustomRouteNames &&
    ctx.unmountedCustomRouteNames.has(routeName)
  ) {
    op["x-implementation"] = "stub";
  }
  if (route && route["x-implementation"] === "stub") {
    op["x-implementation"] = "stub";
  }
}

function buildPaths(
  routes: SpecRouteEntry[],
  ctx: BuildCtx,
): { paths: PathsObject; tags: string[] } {
  const paths: PathsObject = {};
  const tagSet = new Set<string>();
  for (const entry of routes) {
    const [routeName, route] = singleEntry(entry);
    const { method, openApiPath, op } = buildOperation(routeName, route, ctx);
    markStub({ op, routeName, route }, ctx);
    if (Array.isArray(op.tags)) for (const t of op.tags) tagSet.add(t);
    if (!paths[openApiPath]) paths[openApiPath] = {};
    paths[openApiPath][method] = op;
  }
  return { paths, tags: [...tagSet].sort() };
}

function entityOfRoute(route: SpecRoute): string | null {
  // why: pick whichever of entity/targetEntity/parentEntity is set so the marker covers CRUD, combined/m2m children, and byField parent route variants alike.
  if (typeof route.entity === "string") return route.entity;
  if (typeof route.targetEntity === "string") return route.targetEntity;
  if (typeof route.parentEntity === "string") return route.parentEntity;
  return null;
}

function collectEntitiesWithoutSeeds(datasourceData: RawTypesDoc): Set<string> {
  const out = new Set<string>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = singleEntry<DsTypeDef>(entry);
    const seeds = Array.isArray(def?.seeds) ? def.seeds : [];
    if (seeds.length === 0) out.add(name);
  }
  return out;
}

function collectUnmountedCustomRouteNames(
  routesData: RoutesInputDoc,
): Set<string> {
  const out = new Set<string>();
  for (const entry of routesData.routes ?? []) {
    const [name, rawDef] = singleEntry(entry as Record<string, JsonValue>);
    const def = rawDef as Record<string, JsonValue>;
    if (
      typeof def.service !== "string" ||
      def.service.length === 0 ||
      typeof def.serviceMethod !== "string" ||
      def.serviceMethod.length === 0
    ) {
      out.add(name);
    }
  }
  return out;
}

export interface OpenApiDocumentOut {
  openapi: string;
  info: { title: string; version: string };
  tags?: { name: string }[];
  paths?: PathsObject;
  components?: { schemas: ComponentMap };
}

function buildOpenApiDocument({
  title,
  version,
  paths,
  components,
  tags,
}: {
  title: string;
  version: string;
  paths: PathsObject;
  components: ComponentMap;
  tags: string[];
}): OpenApiDocumentOut {
  const doc: OpenApiDocumentOut = {
    openapi: "3.0.3",
    info: { title, version },
  };
  if (Array.isArray(tags) && tags.length > 0) {
    doc.tags = tags.map((name) => ({ name }));
  }
  doc.paths = paths;
  doc.components = { schemas: components };
  return doc;
}

function assertBuildInputs(
  routesData: RoutesInputDoc,
  viewData: RawTypesDoc,
  datasourceData: RawTypesDoc,
): void {
  for (const [name, value] of [
    ["routesData", routesData],
    ["viewData", viewData],
    ["datasourceData", datasourceData],
  ] as const) {
    if (!value || typeof value !== "object")
      throw new Error(`buildEnrichedOpenApiSpec: ${name} required`);
  }
}

function withEagerWriteBodies(
  routesData: RoutesInputDoc,
  datasourceData: RawTypesDoc,
  viewData: RawTypesDoc,
): RawTypesDoc {
  const eagerWriteBodyTypes = deriveEagerWriteBodyTypes(
    routesData,
    datasourceData,
    viewData,
  );
  if (eagerWriteBodyTypes.length === 0) return viewData;
  return {
    ...viewData,
    types: [...(viewData.types ?? []), ...eagerWriteBodyTypes],
  };
}

function buildWriteResponseSchemasMap(
  components: ComponentMap,
  viewDataWithEager: RawTypesDoc,
  ctx: BuildCtx,
): Map<string, SchemaObject> {
  const writeResponseSchemas = new Map<string, SchemaObject>();
  for (const viewName of Object.keys(components)) {
    const bare = buildWriteResponseSchema(viewName, viewDataWithEager, {
      datasourceData: ctx.datasourceData,
      ds: ctx.ds,
    });
    if (bare) writeResponseSchemas.set(viewName, bare);
  }
  return writeResponseSchemas;
}

interface BuildEnrichedOptions {
  routesData: RoutesInputDoc;
  viewData: RawTypesDoc;
  datasourceData: RawTypesDoc;
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: CaseFormat;
  groupByEntity?: boolean;
  useOptimisticConcurrency?: boolean;
  ds?: DatasourceSettings;
}

/** The exact `expandRoutes` result the OpenAPI doc is built from — the definitive shapes. Returns `viewDataWithEager` too so callers needing the eager-augmented views don't recompute it. */
export function expandRoutesEnriched({
  routesData,
  viewData,
  datasourceData,
  ds = DEFAULT_DS,
}: Pick<
  BuildEnrichedOptions,
  "routesData" | "viewData" | "datasourceData" | "ds"
>): { expanded: ExpandedInput; viewDataWithEager: RawTypesDoc } {
  const viewDataWithEager = withEagerWriteBodies(
    routesData,
    datasourceData,
    viewData,
  );
  const componentProjection = (vd: RawTypesDoc): RawTypesDoc =>
    projectViewTypesByEagerPath(vd, routesData);
  const expanded = expandRoutes({
    routesData,
    viewData: viewDataWithEager,
    datasourceData,
    componentProjection,
    ds,
  }) as ExpandedInput;
  return { expanded, viewDataWithEager };
}

export function buildEnrichedOpenApiSpec({
  routesData,
  viewData,
  datasourceData,
  title = "API",
  version = "0.0.0",
  naming = "original",
  schemaNaming = "Snake",
  groupByEntity = true,
  useOptimisticConcurrency = false,
  ds = DEFAULT_DS,
}: BuildEnrichedOptions): OpenApiDocumentOut {
  assertBuildInputs(routesData, viewData, datasourceData);
  const { expanded, viewDataWithEager } = expandRoutesEnriched({
    routesData,
    viewData,
    datasourceData,
    ds,
  });
  const { components } = expanded;
  const ctx: BuildCtx = {
    naming,
    groupByEntity,
    datasourceData,
    ds,
    useOptimisticConcurrency,
    occByEntity: optimisticConcurrencyByEntity(
      datasourceData,
      useOptimisticConcurrency === true,
    ),
    unmountedCustomRouteNames: collectUnmountedCustomRouteNames(routesData),
    entitiesWithoutSeeds: collectEntitiesWithoutSeeds(datasourceData),
    primaryKeyTypesByEntity: collectPrimaryKeyTypesByEntity(datasourceData),
  };
  ctx.writeResponseSchemas = buildWriteResponseSchemasMap(
    components,
    viewDataWithEager,
    ctx,
  );
  const { paths, tags } = buildPaths(expanded.routes, ctx);
  const doc = buildOpenApiDocument({
    title,
    version,
    paths,
    components,
    tags,
  });
  applySchemaNaming(doc, schemaNaming);
  return doc;
}

export const OPENAPI_DOC_DEFAULTS = Object.freeze({
  title: "Deterministic Backend API",
  version: "0.0.0",
  naming: "original",
  schemaNaming: "Snake" as CaseFormat,
});

/** Project a routes-api document into OpenAPI 3.0.3 (`paths` + `components.schemas`). */
export function buildOpenApiFromRoutesApi({
  routesApi,
  title = OPENAPI_DOC_DEFAULTS.title,
  version = OPENAPI_DOC_DEFAULTS.version,
  naming = OPENAPI_DOC_DEFAULTS.naming,
  schemaNaming = OPENAPI_DOC_DEFAULTS.schemaNaming,
  groupByEntity = true,
  useOptimisticConcurrency = false,
  ds = DEFAULT_DS,
  datasourceData,
}: {
  routesApi: { routes: SpecRouteEntry[]; components: ComponentMap };
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: CaseFormat;
  groupByEntity?: boolean;
  useOptimisticConcurrency?: boolean;
  ds?: DatasourceSettings;
  datasourceData?: RawTypesDoc;
}): OpenApiDocumentOut {
  const dsDoc = datasourceData ?? { types: [] };
  const ctx: BuildCtx = {
    naming,
    groupByEntity,
    datasourceData: dsDoc,
    ds,
    useOptimisticConcurrency,
    occByEntity: optimisticConcurrencyByEntity(
      dsDoc,
      useOptimisticConcurrency === true,
    ),
    unmountedCustomRouteNames: new Set(),
    entitiesWithoutSeeds: collectEntitiesWithoutSeeds(dsDoc),
    primaryKeyTypesByEntity: collectPrimaryKeyTypesByEntity(dsDoc),
  };
  const { paths, tags } = buildPaths(routesApi.routes, ctx);
  const doc = buildOpenApiDocument({
    title,
    version,
    paths,
    components: routesApi.components,
    tags,
  });
  applySchemaNaming(doc, schemaNaming);
  return doc;
}
