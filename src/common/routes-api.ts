import type { JsonValue } from "@deterministic-code/generators-common/yaml-entry";

/** Contract version stamped on every expanded routes-api document. */
export const ROUTES_API_VERSION = "1.0.0";

/** Named JSON Schema / OpenAPI schema object in the routes-api component map. */
export type RoutesApiSchema = {
  type?: string;
  format?: string;
  properties?: Record<string, RoutesApiSchema>;
  items?: RoutesApiSchema;
  required?: string[];
  $ref?: string;
  nullable?: boolean;
  enum?: unknown[];
  default?: unknown;
  maxLength?: number;
  oneOf?: RoutesApiSchema[];
  "x-references"?: string;
};

/** Resolved request/response body: component name, `$ref` schema, rendered example. */
export type RoutesApiBody = {
  name: string;
  schema: { $ref: string } | null;
  example: JsonValue | null;
};

/** One expanded operation (CRUD, combined-route child, or custom). */
export type RoutesApiRouteDef = {
  path: string;
  method: string;
  entity: string | null;
  isCustom: boolean;
  request?: RoutesApiBody;
  response?: RoutesApiBody;
  byField?: string;
  byFieldUnique?: boolean;
  primaryKeyField?: string | null;
};

/** Single-key `{ <routeName>: def }` map. */
export type RoutesApiRouteEntry = Record<string, RoutesApiRouteDef>;

/**
 * Flattened HTTP API catalog: `{ version, routes, components }`.
 * @see https://github.com/deterministic-code/deterministic-specifications/blob/main/backend/routes-api.spec.yaml
 */
export type RoutesApiDoc = {
  version: string;
  routes: RoutesApiRouteEntry[];
  components: Record<string, RoutesApiSchema>;
};
