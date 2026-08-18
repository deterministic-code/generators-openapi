import { DatasourceSettings } from "../../datasource-settings.ts";
import { tsLiteral } from "./ts-sample-literal.ts";
import {
  settingsStr,
  settingsBool,
  type SettingsDict,
} from "../../settings-dict.ts";

type DatasourceInput = NonNullable<
  ConstructorParameters<typeof DatasourceSettings>[0]
>;

export interface DatasourceOptions {
  idType?: string;
  uuid?: string;
  datetime?: string;
  pluralizeTableNames?: boolean;
  useStoredProcedures?: boolean;
  useOptimisticConcurrency?: boolean;
}

/** `DatasourceSettings` from the flat `SettingsDict` — the production path. Reads the `datasource.*` dotted keys; absent leaves fall through to the class defaults. `pluralize_datatable_names` is read tri-state (absent → class default `true`), the two boolean toggles default `false`. */
export function datasourceSettingsForSettings(
  settings: SettingsDict,
): DatasourceSettings {
  const plural = settingsStr(settings, "datasource.pluralize_datatable_names");
  return new DatasourceSettings({
    idType: settingsStr(settings, "datasource.id_type"),
    uuid: settingsStr(settings, "datasource.uuid"),
    datetime: settingsStr(settings, "datasource.datetime"),
    pluralizeDatatableNames: plural === undefined ? undefined : plural === "true",
    useStoredProcedures: settingsBool(settings, "datasource.use_stored_procedures"),
    useOptimisticConcurrency: settingsBool(
      settings,
      "datasource.use_optimistic_concurrency",
    ),
  });
}

/** The project id_type resolved through `DatasourceSettings` (so the loader default applies), or `undefined` when there is no settings object — the one place the validator wiring reads id_type from settings. */
export function idTypeFromSettings(
  settings?: SettingsDict,
): string | undefined {
  return settings ? datasourceSettingsForSettings(settings).idType : undefined;
}

/** `DatasourceSettings` from a generic (possibly partial) generate-options object — the direct-call/unit-test adapter, mirroring `namesFor`. Absent knobs fall back to the class defaults (integer / string uuid / native datetime). */
export function datasourceSettingsFor(
  opts: DatasourceOptions = {},
): DatasourceSettings {
  return new DatasourceSettings({
    idType: opts.idType,
    uuid: opts.uuid,
    datetime: opts.datetime,
    pluralizeDatatableNames: opts.pluralizeTableNames,
    useStoredProcedures: opts.useStoredProcedures,
    useOptimisticConcurrency: opts.useOptimisticConcurrency,
  });
}

/** The `settingsConfig` object literal `createBackendApp` inlines, rendered from a resolved `DatasourceSettings` — so an generated test/app supplies settings directly and never disk-loads `settings.yaml`. Maps `datetimeRepr`→`datetime`, `uuidRepr`→`uuid`. */
export function settingsConfigLiteral(ds: DatasourceSettings): string {
  return tsLiteral({
    pluralizeTableNames: ds.pluralizeTableNames,
    datetime: ds.datetimeRepr,
    uuid: ds.uuidRepr,
    idType: ds.idType,
  });
}
