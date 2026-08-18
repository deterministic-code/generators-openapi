import { parse } from "yaml";
import { parseDatasourceTypes } from "./parse-datasource-types.ts";
import { buildEnrichedOpenApiSpec } from "./openapi-spec-build.ts";
import { datasourceSettingsForSettings } from "./ts-datasource-settings.ts";

type SettingsArg = Parameters<typeof datasourceSettingsForSettings>[0];

interface OpenApiOverrides {
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: string;
  groupByEntity?: boolean;
}

interface BuildFromDataOptions {
  routesData: unknown;
  viewData: unknown;
  datasourceData: unknown;
  settings: SettingsArg;
  overrides?: OpenApiOverrides;
}

/** The `create-openapi-docs` flag defaults — the openapi doc the pipeline actually generates (it passes none of these overrides). `groupByEntity` defaults true via the `!== false` check below. */
export const OPENAPI_DOC_DEFAULTS = Object.freeze({
  title: "Deterministic Backend API",
  version: "0.0.0",
  naming: "original",
  schemaNaming: "Snake",
});

/** Build the enriched OpenAPI doc from already-parsed contract data. Shared by the `openapi` catalog generator and the legacy `create-openapi-docs` CLI so the flag defaults and `settings`-derived knobs live in one place. `overrides` carries the CLI flag values (all optional; unset falls back to the default). */
export const buildOpenApiDocFromData = ({
  routesData,
  viewData,
  datasourceData,
  settings,
  overrides = {},
}: BuildFromDataOptions) => {
  const ds = datasourceSettingsForSettings(settings);
  const buildArgs = {
    routesData,
    viewData,
    datasourceData,
    title: overrides.title ?? OPENAPI_DOC_DEFAULTS.title,
    version: overrides.version ?? OPENAPI_DOC_DEFAULTS.version,
    naming: overrides.naming ?? OPENAPI_DOC_DEFAULTS.naming,
    schemaNaming: overrides.schemaNaming ?? OPENAPI_DOC_DEFAULTS.schemaNaming,
    groupByEntity: overrides.groupByEntity !== false,
    useOptimisticConcurrency: ds.useOptimisticConcurrency,
    ds,
  };
  // buildEnrichedOpenApiSpec is an untyped .mjs whose `= null` defaults infer too narrowly; cast at the boundary
  return buildEnrichedOpenApiSpec(
    buildArgs as unknown as Parameters<typeof buildEnrichedOpenApiSpec>[0],
  );
}

export const buildOpenApiDocFromReader = async ({
  reader,
  settings,
  overrides,
}: {
  reader: {
    read: (name: string) => Promise<string>;
    exists: (name: string) => Promise<boolean>;
  };
  settings: SettingsArg;
  overrides?: OpenApiOverrides;
}) => {
  const datasourceYamlText = (await reader.exists("datasource_types.yaml"))
    ? await reader.read("datasource_types.yaml")
    : "";
  const datasourceSeedsYamlText = (await reader.exists("datasource_seeds.yaml"))
    ? await reader.read("datasource_seeds.yaml")
    : null;
  return buildOpenApiDocFromData({
    routesData: parse(await reader.read("routes.yaml")),
    viewData: parse(await reader.read("view_types.yaml")),
    datasourceData: parseDatasourceTypes(
      datasourceYamlText,
      settings,
      datasourceSeedsYamlText,
    ),
    settings,
    overrides,
  });
};
