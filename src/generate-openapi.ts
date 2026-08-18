import { settingsStr } from "./common/settings.ts";
import type { GenerateContext } from "./common/generate-context.ts";
import { content, type GenerateEntry } from "./common/generate-entry.ts";
import {
  OPENAPI_DOC_DEFAULTS,
  buildOpenApiDocFromReader,
} from "./openapi/codegen/lib/generate-openapi-docs-shared.ts";

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const doc = await buildOpenApiDocFromReader({
    reader: ctx.reader,
    settings: ctx.settings,
    overrides: {
      title:
        settingsStr(ctx.settings, "application_name") ??
        OPENAPI_DOC_DEFAULTS.title,
      version:
        settingsStr(ctx.settings, "codegen.schema_version") ??
        OPENAPI_DOC_DEFAULTS.version,
    },
  });
  return [content("openapi.json", `${JSON.stringify(doc, null, 2)}\n`)];
};
