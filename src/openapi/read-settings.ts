import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { pathExists } from "./path-exists.ts";
export type CaseFormat = "Camel" | "Pascal" | "Snake" | "Kebab" | "Auto";

const DEFAULT_SETTINGS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "default-settings.yaml",
);

/** A parsed YAML/JSON value — the precise recursive type for arbitrary settings documents the deep-merge and raw-document loaders operate on. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CasingBlock = {
  fileNames: CaseFormat | undefined;
  types: CaseFormat | undefined;
  fields: CaseFormat | undefined;
  directories: CaseFormat | undefined;
};
export type LanguageEntry = {
  casing: CasingBlock;
  libraryReferenceMode: string | undefined;
};
export type BackendBlock = {
  languages: string[];
  datasources: string[];
};
export type DatasourceBlock = {
  idType: string | undefined;
  uuid: string | undefined;
  datetime: string | undefined;
  pluralizeDatatableNames: boolean;
  useStoredProcedures: boolean | undefined;
  useOptimisticConcurrency: boolean | undefined;
};
export type FrontendBlock = {
  framework: string | undefined;
  language: string | undefined;
  generateValidators: boolean | undefined;
};
export type CodegenBlock = {
  schemaVersion: string | undefined;
  createIndex: boolean | undefined;
};
export type OtherBlock = {
  organizeByFeature: boolean | undefined;
  generateFileHashList: boolean | undefined;
  errorOnHashOverwrite: boolean | undefined;
  reverseProxy: string;
  proxyBackend: string | undefined;
};
export type ParsedSettings = {
  applicationName: string | undefined;
  applicationTier: string | undefined;
  backend: BackendBlock;
  datasource: DatasourceBlock;
  commentStyle: string | undefined;
  languages: Record<string, LanguageEntry>;
  codegen: CodegenBlock;
  other: OtherBlock;
  frontend: FrontendBlock;
};

let cachedDefaultSettingsPromise:
  | Promise<ParsedSettings | undefined>
  | undefined;
export function loadDefaultSettings(): Promise<ParsedSettings | undefined> {
  if (cachedDefaultSettingsPromise) return cachedDefaultSettingsPromise;
  cachedDefaultSettingsPromise = (async () => {
    const text = await readFile(DEFAULT_SETTINGS_PATH, "utf8");
    return parseSettingsYaml(text);
  })();
  return cachedDefaultSettingsPromise;
}

function mergeSettings(base: JsonValue, override: JsonValue): JsonValue {
  if (override === undefined || override === null) return base;
  // parseSettingsYaml normalizes an omitted list to [], so an empty override inherits the default rather than clobbering it (e.g. backend.languages).
  if (Array.isArray(override)) return override.length > 0 ? override : base;
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof override !== "object"
  ) {
    return override;
  }
  const merged: { [key: string]: JsonValue } = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeSettings(base[key], value);
  }
  return merged;
}

export async function readSettingsWithDefault(
  deterministicDir?: string,
): Promise<ParsedSettings> {
  const defaults = await loadDefaultSettings();
  if (!defaults) {
    throw new Error(
      "invariant: default-settings.yaml failed to parse — the shipped defaults must always parse",
    );
  }
  if (deterministicDir) {
    const settingsPath = join(deterministicDir, "settings.yaml");
    if (await pathExists(settingsPath)) {
      const text = await readFile(settingsPath, "utf8");
      const parsed = parseSettingsYaml(text);
      if (parsed) return mergeSettings(defaults, parsed) as ParsedSettings;
    }
  }
  return defaults;
}

/** The raw settings.yaml (partial) deep-merged over the raw default-settings.yaml, WITHOUT the `parseSettingsYaml` normalization (no unwrap, no snake→camel) — the complete `{ settings: … }` document in its authored shape, so it can be validated strictly against `spec/settings.spec.yaml` (whose required backend/comments/other are supplied by the defaults, while the user's typos/bad enums survive the merge and surface). */
export async function loadRawMergedSettings(
  deterministicDir?: string,
): Promise<JsonValue> {
  const base = yamlLoad(
    await readFile(DEFAULT_SETTINGS_PATH, "utf8"),
  ) as JsonValue;
  if (!deterministicDir) return base;
  const settingsPath = join(deterministicDir, "settings.yaml");
  if (!(await pathExists(settingsPath))) return base;
  const override = yamlLoad(await readFile(settingsPath, "utf8")) as JsonValue;
  return override ? mergeSettings(base, override) : base;
}

/** The raw settings.yaml TEXT deep-merged over the raw default-settings.yaml — the text-input counterpart of {@link loadRawMergedSettings} (which reads from a dir). Verify holds the zip's settings.yaml as text, so it validates the same complete-shape document generate does without writing to disk first. */
export async function mergeRawSettingsTextOverDefaults(
  text: string,
): Promise<JsonValue> {
  const base = yamlLoad(
    await readFile(DEFAULT_SETTINGS_PATH, "utf8"),
  ) as JsonValue;
  const override = yamlLoad(text) as JsonValue;
  return override ? mergeSettings(base, override) : base;
}

/** Read a settings value that must be present — the merged settings.yaml + default-settings.yaml always supplies it, so absence is an incomplete default, not a user error. */
export function requireSetting<T>(value: T, path: string): T {
  if (value === undefined || value === null) {
    throw new Error(
      `invariant: settings.${path} is required but missing — add it to default-settings.yaml`,
    );
  }
  return value;
}

const SUPPORTED_DATASOURCES: readonly string[] = [
  "sqlite",
  "mysql",
  "postgres",
  "sqlserver",
  "oracle",
];

export const SUPPORTED_LANGUAGES: readonly string[] = [
  "typescript",
  "csharp",
  "rust",
];

export const LIBRARY_REFERENCE_MODE_ALLOWED_BY_LANGUAGE: Record<
  string,
  string[]
> = Object.freeze({
  typescript: ["npm", "bundled"],
  rust: ["registry", "bundled"],
  csharp: ["bundled"],
});

export const LIBRARY_REFERENCE_MODE_DEFAULT_BY_LANGUAGE: Record<
  string,
  string
> = Object.freeze({
  typescript: "npm",
  rust: "bundled",
  csharp: "bundled",
});

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

const asString = (v: JsonValue): string | undefined =>
  typeof v === "string" ? v : undefined;
const asBool = (v: JsonValue): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

/** Map an authored/stored casing token (`camel`/`Pascal`/`KEBAB`/…) to its canonical `CaseFormat`, or undefined when unrecognized — the single case-token normalization both the YAML parser and the flat-`SettingsDict` reader share. */
export function canonicalCase(value: unknown): CaseFormat | undefined {
  if (typeof value !== "string") return undefined;
  return PARSE_CANONICAL_CASE[value.toLowerCase()];
}

function canonicalCaseFromYaml(value: JsonValue): CaseFormat | undefined {
  return canonicalCase(value);
}

function parseBackendBlock(backend: Record<string, JsonValue>): BackendBlock {
  const rawDatasources = backend.datasources;
  // Lowercase before any use/filter: settings.yaml is authored with capitalized language/dialect names (e.g. `TypeScript`, `Postgres`), but the catalog, SUPPORTED_DATASOURCES, and the lane/manifest logic are all lowercase. Without this, `TypeScript` drops every backend lane at plan time and `Postgres` is silently filtered out of datasources.
  return {
    languages: Array.isArray(backend.languages)
      ? backend.languages
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.toLowerCase())
      : [],
    datasources: Array.isArray(rawDatasources)
      ? rawDatasources
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.toLowerCase())
          .filter((v) => SUPPORTED_DATASOURCES.includes(v))
      : [],
  };
}

function parseDatasourceBlock(
  datasource: Record<string, JsonValue>,
): DatasourceBlock {
  return {
    idType: asString(datasource.id_type),
    uuid: asString(datasource.uuid),
    datetime: asString(datasource.datetime),
    pluralizeDatatableNames:
      typeof datasource.pluralize_datatable_names === "boolean"
        ? datasource.pluralize_datatable_names
        : true,
    useStoredProcedures: asBool(datasource.use_stored_procedures),
    useOptimisticConcurrency: asBool(datasource.use_optimistic_concurrency),
  };
}

function parseFrontendBlock(
  frontend: Record<string, JsonValue>,
): FrontendBlock {
  return {
    framework: asString(frontend.framework),
    language: asString(frontend.language),
    generateValidators: asBool(frontend.generate_validators),
  };
}

function parseCasingBlock(casing: Record<string, JsonValue>): CasingBlock {
  return {
    fileNames: canonicalCaseFromYaml(casing.file_names),
    types: canonicalCaseFromYaml(casing.types),
    fields: canonicalCaseFromYaml(casing.fields),
    directories: canonicalCaseFromYaml(casing.directories),
  };
}

function parseCodegenBlock(codegen: Record<string, JsonValue>): CodegenBlock {
  return {
    schemaVersion: asString(codegen.schema_version),
    createIndex: asBool(codegen.create_index),
  };
}

function parseOtherBlock(other: Record<string, JsonValue>): OtherBlock {
  return {
    organizeByFeature: asBool(other.organize_by_feature),
    generateFileHashList: asBool(other.generate_file_hash_list),
    errorOnHashOverwrite: asBool(other.error_on_hash_overwrite),
    reverseProxy: asString(other.reverse_proxy) ?? "nginx",
    proxyBackend: asString(other.proxy_backend),
  };
}

function parseLibraryReferenceMode(
  raw: JsonValue,
  lang: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `settings.languages.${lang}.library_reference_mode must be a string (got ${typeof raw}).`,
    );
  }
  const allowed = LIBRARY_REFERENCE_MODE_ALLOWED_BY_LANGUAGE[lang];
  if (!allowed.includes(raw)) {
    throw new Error(
      `settings.languages.${lang}.library_reference_mode must be one of [${allowed.join(", ")}] (got "${raw}").`,
    );
  }
  return raw;
}

/** Parse the per-language settings map (`settings.languages`). Every supported language gets an entry with its `casing` quartet and resolved `libraryReferenceMode`; absent leaves stay `undefined` so `mergeSettings` inherits the default. Unknown language keys throw. */
function parseLanguagesBlock(
  languages: Record<string, JsonValue>,
): Record<string, LanguageEntry> {
  const result: Record<string, LanguageEntry> = {};
  for (const lang of SUPPORTED_LANGUAGES) {
    const rec = asRecord(languages[lang]);
    result[lang] = {
      casing: parseCasingBlock(asRecord(rec.casing)),
      libraryReferenceMode: parseLibraryReferenceMode(
        rec.library_reference_mode,
        lang,
      ),
    };
  }
  for (const key of Object.keys(languages)) {
    if (!SUPPORTED_LANGUAGES.includes(key)) {
      throw new Error(
        `settings.languages.${key} is not a supported language (supported: ${SUPPORTED_LANGUAGES.join(", ")}).`,
      );
    }
  }
  return result;
}

/** The per-language casing quartet, or throw if absent — the single guard both codegen intake sites (`CodegenNames`, `EntityGenerator.generate`) call. default-settings.yaml supplies casing for every supported language, so absence means a malformed settings object. */
export function requireLanguageCasing(
  settings:
    | { languages?: Record<string, { casing: CasingBlock }> }
    | null
    | undefined,
  language: string,
): CasingBlock {
  const casing = settings?.languages?.[language]?.casing;
  if (!casing) {
    throw new Error(
      `invariant: settings.languages.${language}.casing is required but missing — default-settings.yaml supplies it for every supported language, so absence means a malformed settings object`,
    );
  }
  return casing;
}

/**
 * Single canonical structured parser for `settings.yaml`. Returns a
 * normalized object with the same shape as the frontend's `SettingsModel`
 * so server-side consumers (CLI + backend) all see the same view of the
 * file. Both the backend's inline `readDatasourcesFromSettings` /
 * `readOrganizeByFeatureFromSettings` and any future server-side reader
 * delegate to this — fixing a settings parsing bug means changing one
 * regex / one block here, not three places.
 *
 * Returns undefined when the YAML is unparseable so callers can pick
 * their own fallback.
 */
export function parseSettingsYaml(text: JsonValue): ParsedSettings | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  let parsed: JsonValue;
  try {
    parsed = yamlLoad(text) as JsonValue;
  } catch {
    return undefined;
  }
  const settings = asRecord(asRecord(parsed).settings);
  const other = asRecord(settings.other);
  if ("library_reference_mode" in other) {
    throw new Error(
      "settings.other.library_reference_mode has been removed; move it into settings.languages.<lang>.library_reference_mode (e.g. settings.languages.typescript.library_reference_mode: npm).",
    );
  }
  if ("casing" in settings) {
    throw new Error(
      "settings.casing has been removed; move it per-language into settings.languages.<lang>.casing (e.g. settings.languages.typescript.casing.file_names: kebab).",
    );
  }
  if ("packaging" in settings) {
    throw new Error(
      "settings.packaging has been removed; move library_reference_mode_by_language / package_manager_by_language into settings.languages.<lang>.library_reference_mode / package_manager.",
    );
  }
  if ("dialects" in settings) {
    throw new Error(
      "settings.dialects has been renamed to settings.backend; move `dialects: { languages, datasources }` to `backend: { languages, datasources }`. The frontend's language is now declared separately under settings.frontend.language.",
    );
  }
  return {
    applicationName: asString(settings.application_name),
    applicationTier: asString(settings.application_tier),
    backend: parseBackendBlock(asRecord(settings.backend)),
    datasource: parseDatasourceBlock(asRecord(settings.datasource)),
    commentStyle: asString(settings.comments),
    languages: parseLanguagesBlock(asRecord(settings.languages)),
    codegen: parseCodegenBlock(asRecord(settings.codegen)),
    other: parseOtherBlock(other),
    frontend: parseFrontendBlock(asRecord(settings.frontend)),
  };
}

export function resolveLibraryReferenceMode(
  languages: Record<string, LanguageEntry> | undefined,
  language: string,
): string {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(
      `resolveLibraryReferenceMode: unsupported language "${language}".`,
    );
  }
  const explicit = languages?.[language]?.libraryReferenceMode;
  if (explicit) return explicit;
  return LIBRARY_REFERENCE_MODE_DEFAULT_BY_LANGUAGE[language];
}

const PARSE_CANONICAL_CASE: Record<string, CaseFormat> = {
  camel: "Camel",
  pascal: "Pascal",
  snake: "Snake",
  kebab: "Kebab",
  auto: "Auto",
};

/**
 * Read settings.yaml from a file path and return the parsed structured
 * object, or undefined if the file is missing / unreadable / unparseable.
 */
export async function readSettingsYamlFile(
  filePath: string,
): Promise<ParsedSettings | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  return parseSettingsYaml(text);
}

interface FlatSettings {
  idType?: string;
  uuidRepr?: string;
  dateTimeRepr?: string;
  pluralizeDatatableNames: boolean;
  useStoredProcedures: boolean;
  useOptimisticConcurrency: boolean;
  commentStyle?: string;
  organizeByFeature?: boolean;
  generateFileHashList: boolean;
  errorOnHashOverwrite: boolean;
  reverseProxy: string;
  proxyBackend?: string;
}

function applyDatasourceFlatSetting(line: string, result: FlatSettings): void {
  const matchId = line.match(/^\s*id_type:\s*(\w+)/);
  if (matchId) result.idType = matchId[1];
  const matchUuid = line.match(/^\s*uuid:\s*(\w+)/);
  if (matchUuid) result.uuidRepr = matchUuid[1];
  const matchDt = line.match(/^\s*datetime:\s*(\w+)/);
  if (matchDt) result.dateTimeRepr = matchDt[1];
  const matchPlural = line.match(
    /^\s*pluralize_datatable_names:\s*(true|false)\s*$/,
  );
  if (matchPlural) result.pluralizeDatatableNames = matchPlural[1] === "true";
  const matchSp = line.match(/^\s*use_stored_procedures:\s*(true|false)\s*$/);
  if (matchSp) result.useStoredProcedures = matchSp[1] === "true";
  const matchOcc = line.match(
    /^\s*use_optimistic_concurrency:\s*(true|false)\s*$/,
  );
  if (matchOcc) result.useOptimisticConcurrency = matchOcc[1] === "true";
}

function applyFlatSetting(line: string, result: FlatSettings): void {
  applyDatasourceFlatSetting(line, result);
  const matchComments = line.match(/^\s*comments:\s*(\w+)\s*$/);
  if (matchComments) result.commentStyle = matchComments[1];
}

function applyOtherSetting(line: string, result: FlatSettings): void {
  const matchOrganize = line.match(
    /^\s*organize_by_feature:\s*(true|false)\s*$/,
  );
  if (matchOrganize) result.organizeByFeature = matchOrganize[1] === "true";
  const matchGenerateList = line.match(
    /^\s*generate_file_hash_list:\s*(true|false)\s*$/,
  );
  if (matchGenerateList)
    result.generateFileHashList = matchGenerateList[1] === "true";
  const matchErrorOnOverwrite = line.match(
    /^\s*error_on_hash_overwrite:\s*(true|false)\s*$/,
  );
  if (matchErrorOnOverwrite)
    result.errorOnHashOverwrite = matchErrorOnOverwrite[1] === "true";
  const matchReverseProxy = line.match(/^\s*reverse_proxy:\s*(\w+)\s*$/);
  if (matchReverseProxy) result.reverseProxy = matchReverseProxy[1];
  const matchProxyBackend = line.match(/^\s*proxy_backend:\s*(\w+)\s*$/);
  if (matchProxyBackend) result.proxyBackend = matchProxyBackend[1];
}

function applySectionLine(
  line: string,
  section: "other" | null,
  result: FlatSettings,
): "other" | null {
  if (/^\s*other:\s*$/.test(line)) return "other";
  if (/^\S/.test(line)) return null;
  if (section === "other") {
    applyOtherSetting(line, result);
  }
  return section;
}

function parseSettingsText(content: string): FlatSettings {
  const result: FlatSettings = {
    pluralizeDatatableNames: true,
    useStoredProcedures: false,
    useOptimisticConcurrency: false,
    generateFileHashList: true,
    errorOnHashOverwrite: true,
    reverseProxy: "nginx",
  };
  let section: "other" | null = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    applyFlatSetting(line, result);
    section = applySectionLine(line, section, result);
  }
  return result;
}

interface ReadSettingsOpts {
  settingsPath?: string;
}

export async function readSettings(
  cwd: string = process.cwd(),
  opts: ReadSettingsOpts = {},
): Promise<Partial<FlatSettings>> {
  try {
    const settingsPath = opts.settingsPath
      ? resolve(opts.settingsPath)
      : resolve(cwd, "backend/deterministic/settings.yaml");
    return parseSettingsText(await readFile(settingsPath, "utf8"));
  } catch {
    return {};
  }
}
