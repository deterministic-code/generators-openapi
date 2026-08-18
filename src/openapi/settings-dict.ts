import { canonicalCase } from "./read-settings.ts";
import type {
  ParsedSettings,
  CasingBlock,
  LanguageEntry,
} from "./read-settings.ts";

/** The language-neutral settings contract that reaches every generate lane: a flat map of dotted keys to scalar/CSV string values. Fully replaces `ParsedSettings` at the `generate()` boundary so the TS/Rust/C# packs read settings identically. */
export type SettingsDict = Record<string, string>;

function encode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(",");
  return String(value);
}

function put(dict: SettingsDict, key: string, value: unknown): void {
  const encoded = encode(value);
  if (encoded !== undefined) dict[key] = encoded;
}

/** Flatten the loader-resolved `ParsedSettings` tree into the flat `SettingsDict` the emitters read: dotted keys with scalar/CSV string values. Keys whose source value is undefined are omitted, so `settingsStr`/`settingsBool` return undefined for them. */
export function flattenSettings(parsed: ParsedSettings): SettingsDict {
  const dict: SettingsDict = {};
  put(dict, "application_name", parsed.applicationName);
  put(dict, "application_tier", parsed.applicationTier);
  put(dict, "backend.datasources", parsed.backend.datasources);
  put(dict, "backend.languages", parsed.backend.languages);
  put(dict, "frontend.framework", parsed.frontend.framework);
  put(dict, "frontend.language", parsed.frontend.language);
  put(dict, "frontend.generate_validators", parsed.frontend.generateValidators);
  put(dict, "other.organize_by_feature", parsed.other.organizeByFeature);
  put(dict, "other.reverse_proxy", parsed.other.reverseProxy);
  put(dict, "other.proxy_backend", parsed.other.proxyBackend);
  put(dict, "other.generate_file_hash_list", parsed.other.generateFileHashList);
  put(dict, "other.error_on_hash_overwrite", parsed.other.errorOnHashOverwrite);
  put(dict, "comments", parsed.commentStyle);
  put(dict, "datasource.id_type", parsed.datasource.idType);
  put(dict, "datasource.uuid", parsed.datasource.uuid);
  put(dict, "datasource.datetime", parsed.datasource.datetime);
  put(
    dict,
    "datasource.pluralize_datatable_names",
    parsed.datasource.pluralizeDatatableNames,
  );
  put(
    dict,
    "datasource.use_stored_procedures",
    parsed.datasource.useStoredProcedures,
  );
  put(
    dict,
    "datasource.use_optimistic_concurrency",
    parsed.datasource.useOptimisticConcurrency,
  );
  put(dict, "codegen.schema_version", parsed.codegen.schemaVersion);
  put(dict, "codegen.create_index", parsed.codegen.createIndex);
  for (const [lang, entry] of Object.entries(parsed.languages)) {
    put(dict, `languages.${lang}.casing.file_names`, entry.casing.fileNames);
    put(dict, `languages.${lang}.casing.types`, entry.casing.types);
    put(dict, `languages.${lang}.casing.fields`, entry.casing.fields);
    put(dict, `languages.${lang}.casing.directories`, entry.casing.directories);
    put(
      dict,
      `languages.${lang}.library_reference_mode`,
      entry.libraryReferenceMode,
    );
  }
  return dict;
}

/** The raw string value at `key`, or undefined when absent. */
export function settingsStr(
  settings: SettingsDict,
  key: string,
): string | undefined {
  return settings[key];
}

/** `true` only when the value at `key` is exactly `"true"`; any other value (or absence) is `false`. */
export function settingsBool(settings: SettingsDict, key: string): boolean {
  return settings[key] === "true";
}

/** The CSV value at `key` split into a trimmed, empty-dropped list; `[]` when absent. */
export function settingsList(settings: SettingsDict, key: string): string[] {
  const raw = settings[key];
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Rebuild a language's casing quartet from its `languages.<lang>.casing.*` dotted keys — the flat-`SettingsDict` counterpart of `parseCasingBlock`. Each token is normalized through the shared canonical-case map, so absent/unknown leaves resolve to `undefined` (the `Auto` fallback the naming layer applies). */
export function casingFromDict(
  settings: SettingsDict,
  language: string,
): CasingBlock {
  const prefix = `languages.${language}.casing.`;
  return {
    fileNames: canonicalCase(settings[`${prefix}file_names`]),
    types: canonicalCase(settings[`${prefix}types`]),
    fields: canonicalCase(settings[`${prefix}fields`]),
    directories: canonicalCase(settings[`${prefix}directories`]),
  };
}

/** Rebuild one language's `LanguageEntry` (casing + `library_reference_mode`) from the flat `SettingsDict` — the per-language shim the naming/library-mode bridges reconstruct so they read the dict, not a `ParsedSettings` tree. */
export function languageEntryFromDict(
  settings: SettingsDict,
  language: string,
): LanguageEntry {
  return {
    casing: casingFromDict(settings, language),
    libraryReferenceMode: settingsStr(
      settings,
      `languages.${language}.library_reference_mode`,
    ),
  };
}
