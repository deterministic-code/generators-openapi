import { camelCase, pascalCase } from "change-case";
import pluralize from "pluralize";
import { parse } from "yaml";
import type { IDeterministicReader } from "@deterministic-code/generators-common/deterministic-reader";
import {
  primaryKeyFor,
  type DatasourceField,
  type DatasourceType,
} from "../parse-datasource-types.ts";
import {
  loadRoutes,
  ROUTES_YAML,
  type CustomRouteEntry,
  type NestedRouteDescriptor,
  type ParsedRoutes,
  type RouteByField,
  type RouteCandidate,
} from "../parse-routes.ts";
import {
  loadViewTypes,
  type ShapedView,
  type ViewField,
  type ViewType,
} from "../parse-view-types.ts";
import {
  ROUTES_API_VERSION,
  type RoutesApiBody,
  type RoutesApiDoc,
  type RoutesApiRouteDef,
  type RoutesApiRouteEntry,
  type RoutesApiSchema,
} from "./routes-api.ts";
import type { JsonValue } from "@deterministic-code/generators-common/yaml-entry";
import { isRecord, namedEntries } from "@deterministic-code/generators-common/yaml-entry";

const BY_FIELD_METHODS = ["GET", "PUT", "DELETE"] as const;
const EAGER_SUFFIXES = [
  "_eager_body",
  "_eager_create_body",
  "_eager_patch_body",
  "_eager_row",
  "_eager_create_row",
] as const;
const REF_PREFIX = "#/components/schemas/";

const datasourceIdType = (settings: Record<string, string>): string =>
  settings["datasource.id_type"] ?? "integer";

const systemColumns = (
  idType: string,
): Array<{ name: string; type: string }> => [
  { name: "id", type: "id" },
  ...(idType !== "uuid" ? [{ name: "uuid", type: "uuid" }] : []),
  { name: "created", type: "datetime" },
  { name: "updated", type: "datetime" },
];
const TEMPLATE_SAMPLES: Record<string, JsonValue> = {
  datetime: "2026-01-01T00:00:00Z",
  uuid: "00000000-0000-0000-0000-000000000000",
  binary: "",
  boolean: false,
  integer: 0,
  biginteger: 0,
  smallinteger: 0,
  number: 0,
  float: 0,
};

const rec = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const kebabPlural = (name: string): string => {
  const kebab = name.replace(/_/g, "-");
  const parts = kebab.split("-");
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]!);
  return parts.join("-");
};

const isWriteDto = (name: string): boolean =>
  name.startsWith("update_") ||
  name.startsWith("create_") ||
  EAGER_SUFFIXES.some((suffix) => name.endsWith(suffix));

const isEagerName = (name: string): boolean =>
  EAGER_SUFFIXES.some((suffix) => name.endsWith(suffix));

const schemaRef = (name: string): { $ref: string } => ({
  $ref: `${REF_PREFIX}${name}`,
});

const idSchema = (idType: string): RoutesApiSchema => {
  if (idType === "uuid") return { type: "string", format: "uuid" };
  if (idType === "biginteger") return { type: "integer", format: "int64" };
  if (idType === "string") return { type: "string", maxLength: 64 };
  return { type: "integer" };
};

const schemaForPrimitive = (
  type: string,
  size?: number,
): RoutesApiSchema => {
  if (type === "string" || type === "character") {
    return size === undefined
      ? { type: "string" }
      : { type: "string", maxLength: size };
  }
  if (type === "decimal") return { type: "string" };
  if (type === "number") return { type: "number" };
  if (type === "integer" || type === "smallinteger") {
    return { type: "integer", format: "int32" };
  }
  if (type === "biginteger") return { type: "integer", format: "int64" };
  if (type === "float") return { type: "number", format: "float" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "datetime") return { type: "string", format: "date-time" };
  if (type === "binary") return { type: "string", format: "byte" };
  if (type === "uuid") return { type: "string", format: "uuid" };
  if (type === "reference") return { type: "integer" };
  throw new Error(`Unknown datasource field type: ${type}`);
};

const converterTypeForSchema = (schema: RoutesApiSchema): string => {
  if (schema.format === "date-time") return "datetime";
  if (schema.format === "byte") return "binary";
  if (schema.format === "uuid") return "uuid";
  if (schema.format === "int32") return "integer";
  if (schema.format === "int64") return "biginteger";
  if (schema.format === "float") return "float";
  if (schema.type === "integer") return "integer";
  if (schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  return "string";
};

const datasourceFieldSchema = (
  field: DatasourceField,
  ds: { idType: string },
): RoutesApiSchema => {
  let schema: RoutesApiSchema;
  if (field.references?.split(".")[1] === "id") {
    schema = idSchema(ds.idType);
  } else if (
    field.references !== undefined &&
    (field.type === "reference" || field.type === undefined)
  ) {
    schema = { type: "integer" };
  } else {
    schema = schemaForPrimitive(field.type, field.size);
  }
  if (field.isNullable) schema = { ...schema, nullable: true };
  if (field.hasDefault) schema = { ...schema, default: field.defaultValue };
  if (field.references !== undefined && field.references.length > 0) {
    schema = { ...schema, "x-references": field.references };
  }
  return schema;
};

const viewFieldSchema = (field: ViewField): RoutesApiSchema => {
  if (field.kind === "primitive") {
    const inner = schemaForPrimitive(field.base, field.size);
    if (field.isArray) return { type: "array", items: inner };
    return field.isNullable ? { ...inner, nullable: true } : inner;
  }
  const ref = schemaRef(field.base);
  return field.isArray ? { type: "array", items: ref } : ref;
};

const fieldIsRequired = (field: DatasourceField): boolean =>
  field.isNullable !== true && field.hasDefault !== true;

const omitForView = (
  view: ShapedView,
  dsType: DatasourceType | undefined,
): Set<string> => {
  const omit = new Set(view.omit);
  if (dsType?.datasourceType === "readonly-lookup") {
    omit.add("uuid");
    omit.add("created");
    omit.add("updated");
  }
  if (dsType?.fields.some((f) => f.isPrimaryKey === true && f.name !== "id")) {
    const declared = new Set(dsType.fields.map((f) => f.name));
    for (const name of ["id", "uuid", "created", "updated"]) {
      if (!declared.has(name)) omit.add(name);
    }
  }
  return omit;
};

const buildInheritedSchema = (
  view: ShapedView,
  dsType: DatasourceType,
  ds: { idType: string },
): RoutesApiSchema => {
  const omit = omitForView(view, dsType);
  const properties: Record<string, RoutesApiSchema> = {};
  const required: string[] = [];
  const declared = new Set(dsType.fields.map((f) => f.name));
  for (const col of systemColumns(ds.idType)) {
    if (omit.has(col.name) || declared.has(col.name)) continue;
    properties[col.name] =
      col.name === "id" ? idSchema(ds.idType) : schemaForPrimitive(col.type);
    if (isWriteDto(view.name)) required.push(col.name);
  }
  for (const field of dsType.fields) {
    if (omit.has(field.name)) continue;
    properties[field.name] = datasourceFieldSchema(field, ds);
    if (isWriteDto(view.name) && fieldIsRequired(field)) {
      required.push(field.name);
    }
  }
  for (const field of view.fields) {
    properties[field.name] = viewFieldSchema(field);
    if (isWriteDto(view.name) && !field.isNullable) required.push(field.name);
  }
  for (const enrichment of view.enrichments) {
    const named: RoutesApiSchema = {
      type: "string",
      "x-references": `${enrichment.targetTable}.name`,
    };
    properties[enrichment.newField] = enrichment.isNullable
      ? { ...named, nullable: true }
      : named;
  }
  return isWriteDto(view.name)
    ? { type: "object", required, properties }
    : { type: "object", properties };
};

const buildDtoSchema = (fields: ViewField[]): RoutesApiSchema => {
  const properties: Record<string, RoutesApiSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = viewFieldSchema(field);
    if (!field.isNullable) required.push(field.name);
  }
  return { type: "object", required, properties };
};

const buildComponents = (
  views: ViewType[],
  datasources: DatasourceType[],
  ds: { idType: string },
): Record<string, RoutesApiSchema> => {
  const dsByName = new Map(datasources.map((d) => [d.name, d] as const));
  const components: Record<string, RoutesApiSchema> = {};
  for (const view of views) {
    if (view.kind === "union") {
      components[view.name] = {
        oneOf: view.members.map((member) => schemaRef(member)),
      };
      continue;
    }
    const parent = view.inherits !== null ? dsByName.get(view.inherits) : undefined;
    components[view.name] =
      parent === undefined
        ? buildDtoSchema(view.fields)
        : buildInheritedSchema(view, parent, ds);
  }
  return components;
};

const walkSchema = (
  schema: RoutesApiSchema,
  components: Record<string, RoutesApiSchema>,
  stack: string[],
  depth: number,
): JsonValue => {
  if (depth > 32) return null;
  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith(REF_PREFIX)) return null;
    const name = schema.$ref.slice(REF_PREFIX.length);
    const seen = stack.filter((prior) => prior === name).length;
    if (seen > 1) return name;
    const target = components[name];
    return target === undefined
      ? name
      : walkSchema(target, components, [...stack, name], depth + 1);
  }
  if (schema.oneOf !== undefined && schema.oneOf.length > 0) {
    return walkSchema(schema.oneOf[0]!, components, stack, depth);
  }
  if (schema.type === "array") {
    return [
      walkSchema(schema.items ?? {}, components, stack, depth + 1),
    ];
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    const out: Record<string, JsonValue> = {};
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      out[key] = walkSchema(sub, components, stack, depth + 1);
    }
    return out;
  }
  return TEMPLATE_SAMPLES[converterTypeForSchema(schema)] ?? "string";
};

const resolveBody = (
  name: string | undefined,
  components: Record<string, RoutesApiSchema>,
): RoutesApiBody | undefined => {
  if (name === undefined || name.length === 0) return undefined;
  if (components[name] === undefined) {
    return { name, schema: null, example: null };
  }
  const schema = schemaRef(name);
  return {
    name,
    schema,
    example: walkSchema(schema, components, [], 0),
  };
};

const entry = (
  name: string,
  def: Omit<RoutesApiRouteDef, "request" | "response"> & {
    request?: string;
    response?: string;
  },
  components: Record<string, RoutesApiSchema>,
): RoutesApiRouteEntry => {
  const request = resolveBody(def.request, components);
  const response = resolveBody(def.response, components);
  const out: RoutesApiRouteDef = {
    path: def.path,
    method: def.method,
    entity: def.entity,
    isCustom: def.isCustom,
  };
  if (request !== undefined) out.request = request;
  if (response !== undefined) out.response = response;
  if (def.byField !== undefined) out.byField = def.byField;
  if (def.byFieldUnique !== undefined) out.byFieldUnique = def.byFieldUnique;
  if (def.primaryKeyField !== undefined) out.primaryKeyField = def.primaryKeyField;
  return { [name]: out };
};

const crudEntries = (
  candidate: RouteCandidate,
  args: {
    datasources: DatasourceType[];
    idType: string;
    eager: Set<string>;
    components: Record<string, RoutesApiSchema>;
    collectionPath?: string;
    memberPath?: string;
  },
): RoutesApiRouteEntry[] => {
  const entity = candidate.name;
  const collection = args.collectionPath ?? `/api/${kebabPlural(entity)}`;
  const pk = primaryKeyFor(entity, args.datasources, args.idType);
  const member = args.memberPath ?? `${collection}/:${pk.column}`;
  const readonly = candidate.datasourceType === "readonly-lookup";
  const eager = args.eager.has(entity);
  const post = eager
    ? `${entity}_eager_create_body`
    : pk.column !== "id"
      ? `create_${entity}`
      : `update_${entity}`;
  const put = eager ? `${entity}_eager_body` : `update_${entity}`;
  const patch = eager ? `${entity}_eager_patch_body` : `update_${entity}`;
  const camel = camelCase(entity);
  const meta = {
    entity,
    isCustom: false,
    primaryKeyField: pk.column === "id" ? null : pk.column,
  };
  const { components } = args;
  const routes = [
    entry(
      `${camel}List`,
      { path: collection, method: "GET", response: entity, ...meta },
      components,
    ),
    entry(
      `${camel}Get`,
      { path: member, method: "GET", response: entity, ...meta },
      components,
    ),
  ];
  if (readonly) return routes;
  return [
    ...routes,
    entry(
      `${camel}Create`,
      {
        path: collection,
        method: "POST",
        request: post,
        response: entity,
        ...meta,
      },
      components,
    ),
    entry(
      `${camel}Update`,
      { path: member, method: "PUT", request: put, response: entity, ...meta },
      components,
    ),
    entry(
      `${camel}Patch`,
      {
        path: member,
        method: "PATCH",
        request: patch,
        response: entity,
        ...meta,
      },
      components,
    ),
    entry(
      `${camel}Delete`,
      { path: member, method: "DELETE", ...meta },
      components,
    ),
  ];
};

const byFieldEntries = (
  entity: string,
  field: RouteByField,
  readonly: boolean,
  components: Record<string, RoutesApiSchema>,
): RoutesApiRouteEntry[] => {
  const methods = (field.methods ?? [...BY_FIELD_METHODS]).filter((method) =>
    readonly ? method === "GET" : true,
  );
  const collection = `/api/${kebabPlural(entity)}/${field.byField.replace(/_/g, "-")}`;
  const member = `${collection}/:${camelCase(field.byField)}`;
  const camel = camelCase(entity);
  const byPascal = pascalCase(field.byField);
  const meta = {
    entity,
    isCustom: false,
    byField: field.byField,
    byFieldUnique: field.byFieldUnique,
    response: entity,
  };
  const out: RoutesApiRouteEntry[] = [];
  if (methods.includes("GET")) {
    out.push(
      entry(`${camel}GetBy${byPascal}`, { path: member, method: "GET", ...meta }, components),
    );
  }
  if (methods.includes("PUT")) {
    out.push(
      entry(
        `${camel}UpdateBy${byPascal}`,
        { path: member, method: "PUT", request: `update_${entity}`, ...meta },
        components,
      ),
    );
  }
  if (methods.includes("DELETE")) {
    out.push(
      entry(
        `${camel}DeleteBy${byPascal}`,
        {
          path: member,
          method: "DELETE",
          entity,
          isCustom: false,
          byField: field.byField,
          byFieldUnique: field.byFieldUnique,
        },
        components,
      ),
    );
  }
  return out;
};

const customEntry = (
  custom: CustomRouteEntry,
  components: Record<string, RoutesApiSchema>,
): RoutesApiRouteEntry | null => {
  const raw = custom.entry[custom.name];
  if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.method !== "string") {
    return null;
  }
  const requestName = typeof raw.request === "string" ? raw.request : undefined;
  const responseName = typeof raw.response === "string" ? raw.response : undefined;
  return entry(
    custom.name,
    {
      path: raw.path,
      method: raw.method,
      entity: typeof raw.entity === "string" ? raw.entity : null,
      isCustom: true,
      request: requestName,
      response: responseName,
    },
    components,
  );
};

const nestedPaths = (
  nested: NestedRouteDescriptor,
): { collection: string; member: string } => {
  const collection = `${nested.parentBasePath}${nested.segment}`;
  return {
    collection,
    member:
      nested.kind === "m2m"
        ? `${collection}/:${nested.targetParam}`
        : `${collection}/:id`,
  };
};

const combinedPrefix = (nested: NestedRouteDescriptor): string =>
  camelCase(nested.parent) + pascalCase(nested.segmentTail.replace(/-/g, "_"));

const combinedEntries = (
  nested: NestedRouteDescriptor,
  components: Record<string, RoutesApiSchema>,
  ds: { idType: string },
): { routes: RoutesApiRouteEntry[]; extra: Record<string, RoutesApiSchema> } => {
  const { collection, member } = nestedPaths(nested);
  const prefix = combinedPrefix(nested);
  if (nested.kind === "direct-fk") {
    const child = nested.child.name;
    const meta = { entity: child, isCustom: false };
    return {
      extra: {},
      routes: [
        entry(`${prefix}List`, { path: collection, method: "GET", response: child, ...meta }, components),
        entry(`${prefix}Create`, { path: collection, method: "POST", request: `update_${child}`, response: child, ...meta }, components),
        entry(`${prefix}Update`, { path: member, method: "PUT", request: `update_${child}`, response: child, ...meta }, components),
        entry(`${prefix}Delete`, { path: member, method: "DELETE", ...meta }, components),
      ],
    };
  }
  const target = nested.target;
  const linkName = `link_${nested.junction}`;
  const extra: Record<string, RoutesApiSchema> = {
    [linkName]: {
      type: "object",
      required: [nested.childFkField],
      properties: {
        [nested.childFkField]: {
          ...idSchema(ds.idType),
          "x-references": `${nested.target}.id`,
        },
      },
    },
  };
  const merged = { ...components, ...extra };
  const meta = { entity: target, isCustom: false };
  return {
    extra,
    routes: [
      entry(`${prefix}List`, { path: collection, method: "GET", response: target, ...meta }, merged),
      entry(`${prefix}LinkByBody`, { path: collection, method: "POST", request: linkName, response: target, ...meta }, merged),
      entry(`${prefix}Get`, { path: member, method: "GET", response: target, ...meta }, merged),
      entry(`${prefix}Link`, { path: member, method: "POST", response: target, ...meta }, merged),
      entry(`${prefix}Unlink`, { path: member, method: "DELETE", ...meta }, merged),
    ],
  };
};

const parentCrudEntries = (
  parent: string,
  parentRoute: string,
  args: {
    datasources: DatasourceType[];
    idType: string;
    eager: Set<string>;
    components: Record<string, RoutesApiSchema>;
  },
): RoutesApiRouteEntry[] => {
  const ds = args.datasources.find((d) => d.name === parent);
  if (ds === undefined || ds.datasourceType === "many-to-many") return [];
  const memberPath = parentRoute.replace(/\{id\}/g, ":id");
  const collectionPath = memberPath.replace(/\/:id$/, "");
  if (collectionPath === memberPath) return [];
  return crudEntries(
    {
      name: parent,
      kind: "datasource_type",
      inheritsNamespace: "datasource_types",
      datasourceType: ds.datasourceType,
      target: ds.target ?? null,
      byFields: [],
    },
    { ...args, collectionPath, memberPath },
  );
};

const eagerRoots = (routesYaml: string): Set<string> => {
  const out = new Set<string>();
  for (const [, block] of namedEntries(rec(parse(routesYaml)).includes)) {
    const paths = rec(block).eager_write_path;
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      const root = String(path).split(".")[0];
      if (root !== undefined && root.length > 0) out.add(root);
    }
  }
  return out;
};

const combinedParentsWithRoute = (routesYaml: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [name, body] of namedEntries(rec(parse(routesYaml)).combined_routes)) {
    const route = rec(body).route;
    if (typeof route === "string") out.set(name, route);
  }
  return out;
};

export const parseRoutesApi = (args: {
  parsed: ParsedRoutes;
  views: ViewType[];
  settings: Record<string, string>;
  routesYaml: string;
}): RoutesApiDoc => {
  const ds = { idType: datasourceIdType(args.settings) };
  const components = buildComponents(args.views, args.parsed.datasources, ds);
  const eager = eagerRoots(args.routesYaml);
  const routedParents = combinedParentsWithRoute(args.routesYaml);
  const routes: RoutesApiRouteEntry[] = [];

  for (const custom of args.parsed.customs) {
    const item = customEntry(custom, components);
    if (item !== null) routes.push(item);
  }

  for (const candidate of args.parsed.candidates) {
    if (candidate.kind !== "datasource_type") continue;
    if (isEagerName(candidate.name)) continue;
    if (routedParents.has(candidate.name)) continue;
    routes.push(
      ...crudEntries(candidate, {
        datasources: args.parsed.datasources,
        idType: ds.idType,
        eager,
        components,
      }),
    );
    const readonly = candidate.datasourceType === "readonly-lookup";
    for (const field of candidate.byFields) {
      routes.push(...byFieldEntries(candidate.name, field, readonly, components));
    }
  }

  for (const [parent, route] of routedParents) {
    routes.push(
      ...parentCrudEntries(parent, route, {
        datasources: args.parsed.datasources,
        idType: ds.idType,
        eager,
        components,
      }),
    );
  }

  for (const nested of args.parsed.nested) {
    const { routes: items, extra } = combinedEntries(nested, components, ds);
    Object.assign(components, extra);
    routes.push(...items);
  }

  return { version: ROUTES_API_VERSION, routes, components };
};

/** Expand authored YAML into the routes-api IR. */
export const loadRoutesApi = async (ctx: {
  reader: IDeterministicReader;
  settings: Record<string, string>;
}): Promise<RoutesApiDoc> => {
  const ds = { idType: datasourceIdType(ctx.settings) };
  const [parsed, views, routesYaml] = await Promise.all([
    loadRoutes(ctx.reader, { idType: ds.idType }),
    loadViewTypes(ctx.reader),
    ctx.reader.read(ROUTES_YAML),
  ]);
  return parseRoutesApi({
    parsed,
    views,
    settings: ctx.settings,
    routesYaml,
  });
};
