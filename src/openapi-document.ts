import type {
  RoutesApiBody,
  RoutesApiDoc,
  RoutesApiRouteDef,
  RoutesApiSchema,
} from "./common/routes-api.ts";
import { namedEntries } from "@deterministic-code/generators-common/yaml-entry";

export const OPENAPI_DOC_DEFAULTS = Object.freeze({
  title: "Deterministic Backend API",
  version: "0.0.0",
  naming: "original",
  schemaNaming: "Snake",
});

type JsonBodyContent = Record<string, { schema: { $ref: string } }>;

type OpenApiOperation = {
  summary: string;
  operationId: string;
  tags?: string[];
  requestBody?: { required: boolean; content: JsonBodyContent };
  responses: Record<
    string,
    { description: string; content?: JsonBodyContent }
  >;
};

export type OpenApiDocumentOut = {
  openapi: string;
  info: { title: string; version: string };
  tags?: { name: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, RoutesApiSchema> };
};

const jsonContent = (body: RoutesApiBody | undefined): JsonBodyContent | undefined =>
  body?.schema === undefined || body.schema === null
    ? undefined
    : { "application/json": { schema: body.schema } };

const operationFor = (
  routeName: string,
  route: RoutesApiRouteDef,
  groupByEntity: boolean,
): OpenApiOperation => {
  const requestContent = jsonContent(route.request);
  const responseContent = jsonContent(route.response);
  return {
    summary: routeName,
    operationId: routeName,
    ...(groupByEntity && route.entity !== null
      ? { tags: [route.entity] }
      : {}),
    ...(requestContent === undefined
      ? {}
      : {
          requestBody: { required: true, content: requestContent },
        }),
    responses: {
      "200": {
        description: "OK",
        ...(responseContent === undefined ? {} : { content: responseContent }),
      },
    },
  };
};

/** Project a routes-api document into OpenAPI 3.0.3 (`paths` + `components.schemas`). */
export const buildOpenApiFromRoutesApi = ({
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
}): OpenApiDocumentOut => {
  const paths: OpenApiDocumentOut["paths"] = {};
  const tagSet = new Set<string>();
  for (const [routeName, route] of namedEntries(routesApi.routes)) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) {
      continue;
    }
    const def = route as RoutesApiRouteDef;
    const method = def.method.toLowerCase();
    const op = operationFor(routeName, def, groupByEntity);
    if (op.tags) for (const tag of op.tags) tagSet.add(tag);
    paths[def.path] ??= {};
    paths[def.path][method] = op;
  }
  const tags = [...tagSet].sort();
  return {
    openapi: "3.0.3",
    info: { title, version },
    ...(tags.length > 0 ? { tags: tags.map((name) => ({ name })) } : {}),
    paths,
    components: { schemas: routesApi.components },
  };
};
