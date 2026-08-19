import type { IDeterministicReader } from "@deterministic-code/generators-common/deterministic-reader";
import { content, type GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import {
  OPENAPI_DOC_DEFAULTS,
  OpenApiConverter,
} from "./openapi-converter.ts";
import { loadRoutesApi } from "./common/routes-api-converter.ts";

export const generate = async (ctx: {
  reader: IDeterministicReader;
  settings: Record<string, string>;
}): Promise<GenerateEntry[]> => {
  const routesApi = await loadRoutesApi(ctx);
  const doc = new OpenApiConverter({
    title: ctx.settings.application_name ?? OPENAPI_DOC_DEFAULTS.title,
    version:
      ctx.settings["codegen.schema_version"] ?? OPENAPI_DOC_DEFAULTS.version,
    settings: ctx.settings,
  }).convert(routesApi);
  return [content("openapi.json", `${JSON.stringify(doc, null, 2)}\n`)];
};
