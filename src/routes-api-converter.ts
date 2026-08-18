import { parse } from "yaml";
import type { GenerateContext, SettingsDict } from "./common/generate-context.ts";
import { isRecord } from "./common/yaml-entry.ts";
import type { JsonValue } from "./expand/case.ts";
import { datasourceSettingsForSettings } from "./expand/datasource-settings.ts";
import { expandRoutesEnriched } from "./expand/openapi-document.ts";
import { parseDatasourceTypes } from "./expand/parse-datasource-types.ts";
import type { RawTypesDoc } from "./expand/deterministic-shapes.ts";
import {
  ROUTES_API_VERSION,
  type RoutesApiBody,
  type RoutesApiDoc,
  type RoutesApiRouteDef,
  type RoutesApiRouteEntry,
  type RoutesApiSchema,
} from "./routes-api.ts";

const asBody = (value: unknown): RoutesApiBody | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return {
      name: value,
      schema: { $ref: `#/components/schemas/${value}` },
      example: null,
    };
  }
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const name = value.name;
  const schema =
    isRecord(value.schema) && typeof value.schema.$ref === "string"
      ? { $ref: value.schema.$ref }
      : name.length > 0
        ? { $ref: `#/components/schemas/${name}` }
        : null;
  return {
    name,
    schema,
    example: (value.example as JsonValue | null | undefined) ?? null,
  };
};

const asRouteDef = (def: unknown): RoutesApiRouteDef | null => {
  if (!isRecord(def)) return null;
  if (typeof def.path !== "string" || typeof def.method !== "string") {
    return null;
  }
  const request = asBody(def.request);
  const response = asBody(def.response);
  const out: RoutesApiRouteDef = {
    path: def.path,
    method: def.method,
    entity: typeof def.entity === "string" ? def.entity : null,
    isCustom: def.isCustom === true,
  };
  if (request !== undefined) out.request = request;
  if (response !== undefined) out.response = response;
  if (typeof def.byField === "string") out.byField = def.byField;
  if (typeof def.byFieldUnique === "boolean") {
    out.byFieldUnique = def.byFieldUnique;
  }
  if (def.primaryKeyField === null) out.primaryKeyField = null;
  else if (typeof def.primaryKeyField === "string") {
    out.primaryKeyField = def.primaryKeyField;
  }
  return out;
};

const toRouteEntry = (item: unknown): RoutesApiRouteEntry | null => {
  if (!isRecord(item)) return null;
  const name = Object.keys(item)[0];
  if (name === undefined) return null;
  const def = asRouteDef(item[name]);
  if (def === null) return null;
  return { [name]: def };
};

/** Expands authored `routes.yaml` (+ views and datasources) into the routes-api IR. */
export class RoutesApiConverter {
  convert(args: {
    routesData: unknown;
    viewData: unknown;
    datasourceData: unknown;
    settings: SettingsDict;
  }): RoutesApiDoc {
    const ds = datasourceSettingsForSettings(args.settings);
    const { expanded } = expandRoutesEnriched({
      routesData: args.routesData as Parameters<
        typeof expandRoutesEnriched
      >[0]["routesData"],
      viewData: args.viewData as RawTypesDoc,
      datasourceData: args.datasourceData as RawTypesDoc,
      ds,
    });
    return this.#fromExpanded(expanded);
  }

  async fromReader(ctx: GenerateContext): Promise<RoutesApiDoc> {
    const datasourceYamlText = (await ctx.reader.exists("datasource_types.yaml"))
      ? await ctx.reader.read("datasource_types.yaml")
      : "";
    const datasourceSeedsYamlText = (await ctx.reader.exists(
      "datasource_seeds.yaml",
    ))
      ? await ctx.reader.read("datasource_seeds.yaml")
      : null;
    return this.convert({
      routesData: parse(await ctx.reader.read("routes.yaml")),
      viewData: parse(await ctx.reader.read("view_types.yaml")),
      datasourceData: parseDatasourceTypes(
        datasourceYamlText,
        ctx.settings,
        datasourceSeedsYamlText,
      ),
      settings: ctx.settings,
    });
  }

  #fromExpanded(expanded: {
    routes: unknown[];
    components: Record<string, unknown>;
  }): RoutesApiDoc {
    const routes = expanded.routes.flatMap((item) => {
      const entry = toRouteEntry(item);
      return entry === null ? [] : [entry];
    });
    return {
      version: ROUTES_API_VERSION,
      routes,
      components: expanded.components as Record<string, RoutesApiSchema>,
    };
  }
}

