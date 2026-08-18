import npmPluralize from "pluralize";
import { snakeCase } from "change-case";

const SHORTHAND_VERB_RE = /^(get|put|delete)_/i;
const VERB_TO_METHODS: Record<string, string[]> = {
  get: ["GET"],
  put: ["PUT"],
  delete: ["DELETE"],
};

interface FieldEntry {
  [key: string]: unknown;
}

interface EntityDef {
  fields?: FieldEntry[];
}

interface DatasourceData {
  types?: Record<string, EntityDef>[];
}

interface ByFieldEntry {
  entity: string;
  byField: string;
  methods: string[] | null;
}

function singularizeLastToken(snakePlural: string): string {
  const parts = snakePlural.split("_");
  if (parts.length === 0) return snakePlural;
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = npmPluralize.singular(last);
  return parts.join("_");
}

function indexEntities(
  datasourceData?: DatasourceData | null,
): Map<string, EntityDef> {
  const map = new Map<string, EntityDef>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    map.set(name, def);
  }
  return map;
}

function entityHasField(entityDef: EntityDef, fieldName: string): boolean {
  if (fieldName === "id") return true;
  const raw = entityDef.fields;
  const fields = Array.isArray(raw) ? raw : [];
  for (const f of fields) {
    if (fieldName in f) return true;
  }
  return false;
}

function parseVerb(token: string): { methods: string[] | null; body: string } {
  const verbMatch = SHORTHAND_VERB_RE.exec(token);
  if (!verbMatch) return { methods: null, body: token };
  return {
    methods: VERB_TO_METHODS[verbMatch[1].toLowerCase()],
    body: token.slice(verbMatch[0].length),
  };
}

function splitEntityField(
  token: string,
  body: string,
): { entity: string; byField: string } {
  const splitIdx = body.lastIndexOf("_by_");
  if (splitIdx < 0) {
    throw new Error(
      `parseByFieldEntry: route key \`${token}\` is missing \`_by_\` separator`,
    );
  }
  const pluralSnake = body.slice(0, splitIdx);
  const camelField = body.slice(splitIdx + "_by_".length);
  if (!pluralSnake || !camelField) {
    throw new Error(
      `parseByFieldEntry: route key \`${token}\` has empty entity or field around \`_by_\``,
    );
  }
  return {
    entity: singularizeLastToken(pluralSnake),
    byField: snakeCase(camelField),
  };
}

function parseShorthand(
  token: unknown,
  datasourceData?: DatasourceData | null,
): ByFieldEntry {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`parseByFieldEntry: expected non-empty string token`);
  }
  const { methods, body } = parseVerb(token);
  const { entity, byField } = splitEntityField(token, body);
  const entityDef = indexEntities(datasourceData).get(entity);
  if (!entityDef) {
    throw new Error(
      `parseByFieldEntry: unknown entity \`${entity}\` in route \`${token}\``,
    );
  }
  if (!entityHasField(entityDef, byField)) {
    throw new Error(
      `parseByFieldEntry: field \`${byField}\` not found on entity \`${entity}\` in route \`${token}\``,
    );
  }
  return { entity, byField, methods };
}

function parseVerboseDef(
  key: string,
  def: Record<string, unknown>,
): ByFieldEntry {
  if (typeof def.entity !== "string" || typeof def.byField !== "string") {
    throw new Error(
      `parseByFieldEntry: route \`${key}\` has non-string entity/byField`,
    );
  }
  return {
    entity: def.entity,
    byField: def.byField,
    methods: Array.isArray(def.methods) ? def.methods : null,
  };
}

/**
 * `{ entity, byField, methods } | null` from a routes entry. Forms: string
 * (`"get_attachments_by_messageId"`), empty-map (`{ "<name>": null }`), or
 * legacy verbose (`{ <name>: { entity, byField, methods? } }`); anything else
 * (custom routes) → null. Throws when shorthand can't resolve a known entity/field.
 */
export function parseByFieldEntry(
  entry: unknown,
  datasourceData?: DatasourceData | null,
): ByFieldEntry | null {
  if (entry == null) return null;
  if (typeof entry === "string") {
    return parseShorthand(entry, datasourceData);
  }
  if (typeof entry !== "object") return null;
  const pairs = Object.entries(entry);
  if (pairs.length === 0) return null;
  const [key, def] = pairs[0];
  if (def == null) {
    return parseShorthand(key, datasourceData);
  }
  if (typeof def !== "object") return null;
  if ("entity" in def && "byField" in def) {
    return parseVerboseDef(key, def as Record<string, unknown>);
  }
  return null;
}
