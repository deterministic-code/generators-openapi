interface DatasourceData {
  types?: Record<string, unknown>[];
}

/** Index a datasource's `types` list (each a single-key `{ name: def }` entry) by entity name. */
export function indexDatasourceByName(
  datasourceData?: DatasourceData | null,
): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const entry of datasourceData?.types ?? []) {
    const [name, def] = Object.entries(entry)[0];
    byName.set(name, def);
  }
  return byName;
}
