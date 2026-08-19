import {
  OPENAPI_DOC_DEFAULTS,
  renderOpenApiFromRoutesApi,
} from "./openapi-document.ts";
import type { RoutesApiDoc } from "./common/routes-api.ts";

export { OPENAPI_DOC_DEFAULTS };

export type OpenApiConverterOptions = {
  title?: string;
  version?: string;
  naming?: string;
  schemaNaming?: string;
  groupByEntity?: boolean;
  settings?: Record<string, string>;
};

/** Projects a routes-api document into an OpenAPI 3.0.3 JSON document. */
export class OpenApiConverter {
  #options: OpenApiConverterOptions;

  constructor(options: OpenApiConverterOptions = {}) {
    this.#options = options;
  }

  convert(routesApi: RoutesApiDoc): string {
    return renderOpenApiFromRoutesApi({
      routesApi,
      title: this.#options.title ?? OPENAPI_DOC_DEFAULTS.title,
      version: this.#options.version ?? OPENAPI_DOC_DEFAULTS.version,
      naming: this.#options.naming ?? OPENAPI_DOC_DEFAULTS.naming,
      schemaNaming:
        this.#options.schemaNaming ?? OPENAPI_DOC_DEFAULTS.schemaNaming,
      groupByEntity: this.#options.groupByEntity !== false,
    });
  }
}
