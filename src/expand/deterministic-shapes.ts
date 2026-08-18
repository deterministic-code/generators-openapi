import type { Enrichment } from "./view-expand.ts";

/** A single field's raw definition as authored inside a `{ fieldName: def }` entry in `datasource_types` / `view_types` YAML. Keys stay in wire casing. */
export interface RawFieldDef {
  type: string;
  is_nullable?: boolean;
  is_unique?: boolean;
  primary_key?: boolean;
  size?: number;
  min_size?: number;
  references?: string;
}

/** One field slot — YAML lists fields as single-key `{ name: def }` maps. */
export type RawFieldEntry = Record<string, RawFieldDef>;

/** A datasource-type or view-type definition body. `__enrichments` / `__omitFromInherited` are internal markers the view expander stamps on during auto-enrich, never authored. */
export interface RawTypeDef {
  datasource_type?: string | null;
  use_optimistic_concurrency?: boolean;
  inherits?: string;
  fields?: RawFieldEntry[];
  omit?: string[];
  one_of?: string[];
  __enrichments?: Enrichment[];
  __omitFromInherited?: string[];
}

/** One type slot — `{ typeName: def }`. */
export type RawTypeEntry = Record<string, RawTypeDef>;

/** An entry in a doc's `includes:` list — a single-key directive map whose value shape depends on the key. */
export type RawIncludeEntry = Record<string, unknown>;

/** A parsed `datasource_types` / `view_types` / `routes` doc: the ordered `types` list plus any `includes` directives. */
export interface RawTypesDoc {
  types?: RawTypeEntry[];
  includes?: RawIncludeEntry[];
}

/** The `datasource_types` auto-enrich directive a view doc carries in `includes:` — which datasource types to pass through (`include`), an optional `filter` expression, and whether to auto-enrich FK columns. */
export interface DatasourceDirective {
  include?: string;
  filter?: string;
  auto_enrich?: boolean;
}

/** The `view_type_routes` directive a routes doc carries in `includes:` — the eager read/write path lists the expander walks. */
export interface RouteViewTypeDirective {
  eager_path?: unknown[];
  eager_write_path?: unknown[];
}

/** The object a `datasource_types.filter` expression is evaluated against: the type's `name` and its `datasource_type` tag. */
export interface FilterTypeObj {
  name: string;
  datasource_type: string | null;
}

/** Decode a single-key YAML entry `{ key: value }` into its `[key, value]` pair. Every `datasource_types` / `view_types` field- and type-slot is authored this way. */
export function singleEntry<T>(entry: Record<string, T>): [string, T] {
  return Object.entries(entry)[0];
}
