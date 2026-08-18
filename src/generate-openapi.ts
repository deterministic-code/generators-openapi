import { settingsStr } from "./common/settings.ts";
import type { GenerateContext } from "./common/generate-context.ts";
import { content, type GenerateEntry } from "./common/generate-entry.ts";
import {
  OPENAPI_DOC_DEFAULTS,
  OpenApiConverter,
} from "./openapi-converter.ts";
import { RoutesApiConverter } from "./routes-api-converter.ts";

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const routesApi = await new RoutesApiConverter().fromReader(ctx);
  const doc = new OpenApiConverter({
    title:
      settingsStr(ctx.settings, "application_name") ??
      OPENAPI_DOC_DEFAULTS.title,
    version:
      settingsStr(ctx.settings, "codegen.schema_version") ??
      OPENAPI_DOC_DEFAULTS.version,
    settings: ctx.settings,
  }).convert(routesApi);
  return [content("openapi.json", `${JSON.stringify(doc, null, 2)}\n`)];
};
