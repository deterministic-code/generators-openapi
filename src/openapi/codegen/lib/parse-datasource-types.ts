import { parse } from "yaml";
import { materializeReferenceTypes } from "../../datasource-references.ts";
import { datasourceSettingsForSettings } from "./ts-datasource-settings.ts";
import type { SettingsDict } from "../../settings-dict.ts";

type SeedRows = unknown[];

/** Index a `datasource_seeds.yaml` doc's `seeds:` list to `table name → rows`. Each list item is a single-key `{ table: [ {idN: row}, … ] }` entry; a malformed or absent doc yields an empty index. */
function seedRowsByTable(seedsYamlText: string): Map<string, SeedRows> {
  const doc = parse(seedsYamlText) as { seeds?: unknown } | null;
  const list = Array.isArray(doc?.seeds) ? doc.seeds : [];
  const byTable = new Map<string, SeedRows>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const pair = Object.entries(entry as Record<string, unknown>)[0];
    if (!pair) continue;
    const [name, rows] = pair;
    if (Array.isArray(rows)) byTable.set(name, rows);
  }
  return byTable;
}

/** Attach each table's companion seed rows onto its parsed type def under `seeds`, so downstream generators that read `def.seeds` see the same shape they read when seeds still nested under the type. Mutates and returns `datasourceData`. */
export function hydrateSeeds<T>(
  datasourceData: T,
  seedsYamlText: string | null | undefined,
): T {
  if (!seedsYamlText) return datasourceData;
  const byTable = seedRowsByTable(seedsYamlText);
  if (byTable.size === 0) return datasourceData;
  const types = (datasourceData as { types?: unknown })?.types;
  if (!Array.isArray(types)) return datasourceData;
  for (const entry of types) {
    if (!entry || typeof entry !== "object") continue;
    const pair = Object.entries(entry as Record<string, unknown>)[0];
    if (!pair) continue;
    const [name, def] = pair;
    if (def && typeof def === "object" && byTable.has(name)) {
      (def as Record<string, unknown>).seeds = byTable.get(name);
    }
  }
  return datasourceData;
}

/** Parse datasource_types YAML text and materialize every type-less `references` field's inherited parent-PK type — the single parse+resolve boundary for the datasource contract, so every downstream generator that reads `field.type` sees a resolved type rather than `undefined`. Seed rows live in the companion `datasource_seeds.yaml`; pass its text to fold each table's `seeds` back onto the parsed type def. */
export function parseDatasourceTypes(
  datasourceYamlText: string,
  settings: SettingsDict,
  seedsYamlText?: string | null,
) {
  const idType = datasourceSettingsForSettings(settings).idType;
  const data = materializeReferenceTypes(parse(datasourceYamlText), idType);
  return hydrateSeeds(data, seedsYamlText);
}
