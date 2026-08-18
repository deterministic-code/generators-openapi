import {
  camelCase,
  kebabCase,
  pascalCase,
  snakeCase,
} from "change-case";
import pluralize from "pluralize";
import {
  requireLanguageCasing,
  type CaseFormat,
  type CasingBlock,
} from "./read-settings.ts";

export type { CaseFormat };

const LANGUAGE_DEFAULTS: Record<
  string,
  { fileFormat: CaseFormat; classFormat: CaseFormat; fieldFormat: CaseFormat; dirFormat: CaseFormat }
> = {
  typescript: { fileFormat: "Kebab", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Kebab" },
  ts: { fileFormat: "Kebab", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Kebab" },
  javascript: { fileFormat: "Kebab", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Kebab" },
  js: { fileFormat: "Kebab", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Kebab" },
  python: { fileFormat: "Snake", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Snake" },
  py: { fileFormat: "Snake", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Snake" },
  "c#": { fileFormat: "Pascal", classFormat: "Pascal", fieldFormat: "Pascal", dirFormat: "Pascal" },
  java: { fileFormat: "Pascal", classFormat: "Pascal", fieldFormat: "Camel", dirFormat: "Pascal" },
  csharp: { fileFormat: "Pascal", classFormat: "Pascal", fieldFormat: "Pascal", dirFormat: "Pascal" },
  cs: { fileFormat: "Pascal", classFormat: "Pascal", fieldFormat: "Pascal", dirFormat: "Pascal" },
  rust: { fileFormat: "Snake", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Snake" },
  rs: { fileFormat: "Snake", classFormat: "Pascal", fieldFormat: "Snake", dirFormat: "Snake" },
};

export const toCase = (name: string, format: CaseFormat): string => {
  switch (format) {
    case "Camel":
      return camelCase(name);
    case "Pascal":
      return pascalCase(name);
    case "Snake":
      return snakeCase(name);
    case "Kebab":
      return kebabCase(name);
    default:
      throw new Error(`Unknown case format: ${format}`);
  }
};

export const kebabPlural = (name: string): string => {
  const parts = name.replace(/_/g, "-").split("-");
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]!);
  return parts.join("-");
};

const resolveAutoCasing = (
  language: string,
  options: {
    fileFormat: CaseFormat;
    classFormat: CaseFormat;
    fieldFormat: CaseFormat;
    dirFormat: CaseFormat;
  },
) => {
  const key = language.toLowerCase().replace(/[\s_-]/g, "");
  const defaults = LANGUAGE_DEFAULTS[key];
  if (!defaults) {
    throw new Error(`resolveAutoCasing: unknown language "${language}"`);
  }
  return {
    fileFormat: options.fileFormat === "Auto" ? defaults.fileFormat : options.fileFormat,
    classFormat: options.classFormat === "Auto" ? defaults.classFormat : options.classFormat,
    fieldFormat: options.fieldFormat === "Auto" ? defaults.fieldFormat : options.fieldFormat,
    dirFormat: options.dirFormat === "Auto" ? defaults.dirFormat : options.dirFormat,
  };
};

const VARIANT_PREFIXES = ["update_", "create_"];

const DOTTED_LANGS = new Set(["typescript", "javascript"]);

function snakePluralStem(entity: string): string {
  const parts = entity.split(/[_-]/);
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]);
  return parts.join("_");
}

const LANG_EXT: Record<string, string> = {
  typescript: ".ts",
  javascript: ".js",
  rust: ".rs",
  csharp: ".cs",
  java: ".java",
  python: ".py",
};

// Method-identifier casing is a language convention, not a settings knob (classFormat governs types, fieldFormat governs columns): TS/JS/Java methods are camelCase, C#/Go PascalCase, Rust/Python snake_case.
const LANG_METHOD_FORMAT: Record<string, CaseFormat> = {
  typescript: "Camel",
  javascript: "Camel",
  java: "Camel",
  csharp: "Pascal",
  go: "Pascal",
  rust: "Snake",
  python: "Snake",
};

interface ArtifactRule {
  role: string | null;
  roleInFlat: boolean;
  bfMarker?: string;
  bfMarkerDotted?: boolean;
  variant?: boolean;
  stem?: (entity: string) => string;
}

/**
 * Per-artifact naming rules. The `role` token ("view"/"service") is part of the
 * cased stem (toCase applies), so it follows fileFormat. `roleInFlat` = the role is
 * present in the flat filename too (services), not only under by-feature. `variant`
 * = the artifact has create/update-form derivatives whose feature is the base
 * entity. `bfMarker` is a by-feature disambiguator ("validator"/"router") the
 * dotted languages (TS/JS) render as a secondary extension (`.validator`) when
 * `bfMarkerDotted`, and every other language folds into the cased snake stem
 * (`order_validator`) — vertical-slice features share one dir, so the role has to
 * live in the filename there.
 */
const RULES: Record<string, ArtifactRule> = {
  "datasource-type": { role: null, roleInFlat: false },
  "datasource-validator": {
    role: null,
    roleInFlat: false,
    bfMarker: "validator",
    bfMarkerDotted: true,
  },
  "view-type": {
    role: "view",
    roleInFlat: false,
    variant: true,
  },
  "view-validator": {
    role: "view",
    roleInFlat: false,
    bfMarker: "validator",
    bfMarkerDotted: true,
    variant: true,
  },
  service: { role: "service", roleInFlat: true },
  route: {
    role: null,
    roleInFlat: false,
    bfMarker: "router",
    bfMarkerDotted: false,
    stem: snakePluralStem,
  },
  enrichment: {
    role: null,
    roleInFlat: false,
    stem: (entity) => `${entity}_name_enrichment`,
  },
};

const DEFAULT_RULE: ArtifactRule = { role: null, roleInFlat: false };

function ruleFor(artifact: string): ArtifactRule {
  return RULES[artifact] ?? DEFAULT_RULE;
}

function variantPrefixOf(entity: string, rule: ArtifactRule): string | null {
  if (!rule.variant) return null;
  return VARIANT_PREFIXES.find((p) => entity.startsWith(p)) ?? null;
}

function isVariant(entity: string, rule: ArtifactRule): boolean {
  return variantPrefixOf(entity, rule) !== null;
}

function featureBaseOf(entity: string, rule: ArtifactRule): string {
  const prefix = variantPrefixOf(entity, rule);
  return prefix ? entity.slice(prefix.length) : entity;
}

function stemOf(
  entity: string,
  rule: ArtifactRule,
  { byFeature, language }: { byFeature: boolean; language: string },
): string {
  let base;
  if (rule.stem) base = rule.stem(entity);
  else if (isVariant(entity, rule)) base = entity;
  else if (rule.role && (byFeature || rule.roleInFlat)) {
    base = `${entity}_${rule.role}`;
  } else base = entity;
  if (byFeature && rule.bfMarker && !DOTTED_LANGS.has(language)) {
    base = `${base}_${rule.bfMarker}`;
  }
  return base;
}

interface CodegenNamesSettings {
  other?: { organizeByFeature?: boolean };
  backend?: { languages?: string[] };
  languages?: Record<string, { casing: CasingBlock }>;
}

/** The casing-aware deriver of codegen NAMES: filename stems (fileFormat) and class/symbol names (classFormat), plus the resolved by-feature mode. Built straight from the loader-resolved `settings` — casing from `settings.languages[language].casing`, layout from `settings.other.organizeByFeature` — so no generator re-copies or re-defaults a knob. Field/member names live in `CodegenFieldNames`; placement (paths, dirs, imports) in `CodegenLayout`. */
export class CodegenNames {
  language: string;
  fileFormat: CaseFormat;
  classFormat: CaseFormat;
  fieldFormat: CaseFormat;
  dirFormat: CaseFormat;
  ext: string;
  byFeature: boolean;
  multiLanguage: boolean;

  constructor(settings: CodegenNamesSettings, language: string) {
    this.language = language;
    const casing = requireLanguageCasing(settings, language);
    const c = resolveAutoCasing(language, {
      fileFormat: casing.fileNames ?? "Auto",
      classFormat: casing.types ?? "Auto",
      fieldFormat: casing.fields ?? "Auto",
      dirFormat: casing.directories ?? "Auto",
    });
    this.fileFormat = c.fileFormat;
    this.classFormat = c.classFormat;
    this.fieldFormat = c.fieldFormat;
    this.dirFormat = c.dirFormat;
    this.ext = LANG_EXT[language] ?? ".ts";
    this.byFeature = Boolean(settings.other?.organizeByFeature);
    // Durable project fact from settings (not the transient per-invocation --language): a project declaring ≥2 languages nests each backend lane under <lang>/, one dir below the backend-shared sql/ tree — so CodegenLayout resolves the migrations root as ../sql instead of sql.
    const langs = settings?.backend?.languages;
    this.multiLanguage = Array.isArray(langs) && langs.length > 1;
  }

  /** The cased filename stem (no extension). Under by-feature (resolved from settings), full views/validators gain their role token, and non-dotted languages fold the `bfMarker` (validator/router) into the stem. */
  fileBase(entity: string, artifact: string): string {
    const rule = ruleFor(artifact);
    return toCase(
      stemOf(entity, rule, {
        byFeature: this.byFeature,
        language: this.language,
      }),
      this.fileFormat,
    );
  }

  /** The file-name casing (fileFormat) applied to a caller-supplied literal stem — for custom/stub filenames that no artifact rule produces (a rust nested-router base, a custom service file). Keeps the `toCase`-with-`fileFormat` inside the SDK so generators don't reimplement casing. */
  casedFileStem(stem: string): string {
    return toCase(stem, this.fileFormat);
  }

  /** The custom-route stub filename base: the singular `<entity>_route` cased by fileFormat. The `route` artifact rule pluralizes (`orders_router`), so hand-written custom-route stubs need this dedicated singular form; every language derives it here. */
  customRouteFileBase(entity: string): string {
    return this.casedFileStem(`${entity}_route`);
  }

  /** The cased class/symbol name for an entity (classFormat). `suffix` is a role token cased together with the entity (not appended raw), so it follows classFormat — e.g. `className(e, "service")` → `FooService` (Pascal) / `foo_service` (snake). */
  className(entity: string, suffix = ""): string {
    return toCase(suffix ? `${entity}_${suffix}` : entity, this.classFormat);
  }

  /** The typed by-field finder method name for a datasource column, cased by the language's method convention — e.g. `finderMethod("message_id")` → `findByMessageId` (TS) / `find_by_message_id` (rust) / `FindByMessageId` (C#). */
  finderMethod(field: string): string {
    return toCase(
      `find_by_${field}`,
      LANG_METHOD_FORMAT[this.language] ?? "Camel",
    );
  }

  /** The cased class/symbol name for the entity's plural (classFormat), with an optional role-token suffix cased together — e.g. `classNamePlural(e, "router")` → `FooBarsRouter`. */
  classNamePlural(entity: string, suffix = ""): string {
    return toCase(
      suffix ? `${snakePluralStem(entity)}_${suffix}` : snakePluralStem(entity),
      this.classFormat,
    );
  }

  /** The cased plural filename stem (fileFormat), optionally with a literal role suffix cased together — e.g. `fileBasePlural(e, "_router")`. */
  fileBasePlural(entity: string, suffix = ""): string {
    return toCase(`${snakePluralStem(entity)}${suffix}`, this.fileFormat);
  }

  /** The by-feature role extension segment for the artifact: `.validator` for the dotted languages, empty otherwise (non-dotted languages fold the marker into `fileBase`). */
  bfRoleExt(artifact: string): string {
    const rule = ruleFor(artifact);
    if (!rule.bfMarker || !DOTTED_LANGS.has(this.language)) return "";
    return rule.bfMarkerDotted ? `.${rule.bfMarker}` : "";
  }

  /** The base entity that owns the artifact's feature directory (create/update variants collapse into the base entity). Placement plumbing for `CodegenLayout.featureDir`. */
  featureEntity(entity: string, artifact: string): string {
    return featureBaseOf(entity, ruleFor(artifact));
  }
}
