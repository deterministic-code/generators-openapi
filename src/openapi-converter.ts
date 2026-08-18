import type { SettingsDict } from "./common/generate-context.ts";
import type { CaseFormat } from "./expand/case.ts";
import {
  DatasourceSettings,
  datasourceSettingsForSettings,
} from "./expand/datasource-settings.ts";
import type { RawTypesDoc } from "./expand/deterministic-shapes.ts";
import {
  OPENAPI_DOC_DEFAULTS,
  buildOpenApiFromRoutesApi,
  type OpenApiDocumentOut,
} from "./expand/openapi-document.ts";
import type { RoutesApiDoc } from "./routes-api.ts";

export { OPENAPI_DOC_DEFAULTS };
export type { OpenApiDocumentOut };

export type OpenApiConverterOptions = {
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: CaseFormat;
  groupByEntity?: boolean;
  settings?: SettingsDict;
  datasourceData?: RawTypesDoc;
};

/** Projects a routes-api document into an OpenAPI 3.0.3 document. */
export class OpenApiConverter {
  #options: OpenApiConverterOptions;

  constructor(options: OpenApiConverterOptions = {}) {
    this.#options = options;
  }

  convert(routesApi: RoutesApiDoc): OpenApiDocumentOut {
    const settings = this.#options.settings;
    const ds =
      settings === undefined
        ? new DatasourceSettings()
        : datasourceSettingsForSettings(settings);
    return buildOpenApiFromRoutesApi({
      routesApi,
      title: this.#options.title ?? OPENAPI_DOC_DEFAULTS.title,
      version: this.#options.version ?? OPENAPI_DOC_DEFAULTS.version,
      naming: this.#options.naming ?? OPENAPI_DOC_DEFAULTS.naming,
      schemaNaming:
        this.#options.schemaNaming ?? OPENAPI_DOC_DEFAULTS.schemaNaming,
      groupByEntity: this.#options.groupByEntity !== false,
      useOptimisticConcurrency: ds.useOptimisticConcurrency,
      ds,
      datasourceData: this.#options.datasourceData,
    });
  }
}
