/** Shared OpenAPI-document shapes for the openapi helper modules (`openapi-doc-helpers` and `openapi-crud-helpers`). Deliberately partial: the parsed document is loaded by untyped `.mjs` loaders, so every field is optional and dynamic access is narrowed at the read site. */
export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  required?: string[];
  readOnly?: boolean;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  "x-references"?: string;
}

interface OpenApiContent {
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiOperation {
  responses?: Record<string, OpenApiContent>;
  requestBody?: OpenApiContent;
  "x-implementation"?: string;
  "x-no-seeds"?: boolean;
}

export type OpenApiPathItem = Record<string, OpenApiOperation>;

export interface OpenApiDocument {
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

interface ClassificationCommon {
  collectionItem: OpenApiPathItem;
  memberItem: OpenApiPathItem;
}

export interface CrudClassification extends ClassificationCommon {
  kind: "crud";
  updateVerb: "put" | "patch";
}

interface PlainClassification extends ClassificationCommon {
  kind: "readonly" | "readonly-singleton" | "other";
}

export type BucketClassification = CrudClassification | PlainClassification;

export interface Bucket {
  collectionPath: string;
  memberPath: string | null;
  classification?: BucketClassification;
}
