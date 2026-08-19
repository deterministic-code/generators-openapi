import { fill } from "@deterministic-code/generators-common/fill";
import { namedEntries } from "@deterministic-code/generators-common/yaml-entry";
import type {
  RoutesApiBody,
  RoutesApiDoc,
  RoutesApiRouteDef,
  RoutesApiSchema,
} from "./common/routes-api.ts";
import { openapiTmpl, operationTmpl } from "./resources/openapi.ts";

export const OPENAPI_DOC_DEFAULTS = Object.freeze({
  title: "Deterministic Backend API",
  version: "0.0.0",
  naming: "original",
  schemaNaming: "Snake",
});

const pathParamRe = (): RegExp => /:([A-Za-z_][A-Za-z0-9_]*)/g;

const withLast = <T extends Record<string, unknown>>(
  items: T[],
): Array<T & { last: boolean }> =>
  items.map((item, i) => ({ ...item, last: i === items.length - 1 }));

const indentJson = (value: unknown, indent: number): string => {
  const pad = " ".repeat(indent);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : `${pad}${line}`))
    .join("\n");
};

const indentBlock = (text: string, indent: number): string => {
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : `${pad}${line}`))
    .join("\n");
};

const openApiPath = (expressPath: string): string =>
  expressPath.replace(pathParamRe(), "{$1}");

const pathParamNames = (expressPath: string): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of expressPath.matchAll(pathParamRe())) {
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
};

const bodySchema = (
  body: RoutesApiBody | undefined,
): { $ref: string } | null =>
  body?.schema === undefined || body.schema === null ? null : body.schema;

type NamedJson = { nameJson: string };

const namedJson = (name: string): NamedJson => ({
  nameJson: JSON.stringify(name),
});

const operationTokens = (
  routeName: string,
  route: RoutesApiRouteDef,
  groupByEntity: boolean,
) => {
  const requestSchema = bodySchema(route.request);
  const responseSchema = bodySchema(route.response);
  const parameters = pathParamNames(route.path);
  const operationTags =
    groupByEntity && route.entity !== null ? [route.entity] : [];
  return {
    summaryJson: JSON.stringify(routeName),
    operationIdJson: JSON.stringify(routeName),
    hasOperationTags: operationTags.length > 0,
    operationTags: withLast(operationTags.map(namedJson)),
    hasParameters: parameters.length > 0,
    parameters: withLast(parameters.map(namedJson)),
    hasRequestBody: requestSchema !== null,
    requestSchemaJson:
      requestSchema === null ? "" : indentJson(requestSchema, 8),
    hasResponseBody: responseSchema !== null,
    responseSchemaJson:
      responseSchema === null ? "" : indentJson(responseSchema, 8),
  };
};

type PathBucket = {
  path: string;
  operations: Array<{ method: string; json: string }>;
};

/** Project a routes-api document into OpenAPI 3.0.3 via templates. */
export const renderOpenApiFromRoutesApi = ({
  routesApi,
  title = OPENAPI_DOC_DEFAULTS.title,
  version = OPENAPI_DOC_DEFAULTS.version,
  groupByEntity = true,
}: {
  routesApi: RoutesApiDoc;
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: string;
  groupByEntity?: boolean;
}): string => {
  const buckets = new Map<string, PathBucket>();
  const tagSet = new Set<string>();
  for (const [routeName, route] of namedEntries(routesApi.routes)) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) {
      continue;
    }
    const def = route as RoutesApiRouteDef;
    const path = openApiPath(def.path);
    const bucket = buckets.get(path) ?? { path, operations: [] };
    if (!buckets.has(path)) buckets.set(path, bucket);
    if (groupByEntity && def.entity !== null) tagSet.add(def.entity);
    bucket.operations.push({
      method: def.method.toLowerCase(),
      json: fill(operationTmpl, operationTokens(routeName, def, groupByEntity)).trimEnd(),
    });
  }
  const docTags = [...tagSet].sort();
  const schemas = Object.entries(routesApi.components).map(
    ([name, schema]: [string, RoutesApiSchema]) => ({
      nameJson: JSON.stringify(name),
      schemaJson: indentJson(schema, 6),
    }),
  );
  const json = fill(openapiTmpl, {
    titleJson: JSON.stringify(title),
    versionJson: JSON.stringify(version),
    hasDocTags: docTags.length > 0,
    docTags: withLast(docTags.map(namedJson)),
    paths: withLast(
      [...buckets.values()].map((bucket) => ({
        pathJson: JSON.stringify(bucket.path),
        operations: withLast(
          bucket.operations.map((operation) => ({
            methodJson: JSON.stringify(operation.method),
            operationJson: indentBlock(operation.json, 6),
          })),
        ),
      })),
    ),
    schemas: withLast(schemas),
  });
  return `${json.trimEnd()}\n`;
};
