import type { SettingsDict } from "./generate-context.ts";
import { settingsBool, settingsStr } from "./settings.ts";
import {
  idTypeToNative,
  idTypeToZod,
  toNative,
} from "./type-converter.ts";

/** `datasource.id_type` → spec field shape a type-less `references: X.id` inherits. */
const REFERENCE_SHAPE: Record<
  string,
  { type: string; size: number | undefined }
> = {
  integer: { type: "number", size: undefined },
  biginteger: { type: "biginteger", size: undefined },
  uuid: { type: "uuid", size: undefined },
  string: { type: "string", size: 64 },
};

export type DatasourceSettings = {
  idType: string;
  datetimeRepr: string;
  withUuidColumn: boolean;
  tsIdType: string;
  zodIdType: string;
  datetimeType: string;
  useOptimisticConcurrency: boolean;
};

export const datasourceSettings = (
  settings: SettingsDict,
): DatasourceSettings => {
  const idType = settingsStr(settings, "datasource.id_type") ?? "integer";
  const datetimeRepr = settingsStr(settings, "datasource.datetime") ?? "native";
  return {
    idType,
    datetimeRepr,
    withUuidColumn: idType !== "uuid",
    tsIdType: idTypeToNative(idType),
    zodIdType: idTypeToZod(idType),
    useOptimisticConcurrency: settingsBool(
      settings,
      "datasource.use_optimistic_concurrency",
    ),
    datetimeType:
      datetimeRepr === "string" ? toNative("string") : toNative("datetime"),
  };
};

export const referenceIsUuid = (
  ds: DatasourceSettings,
  references: string | undefined,
): boolean =>
  ds.idType === "uuid" &&
  references !== undefined &&
  references.split(".")[1] === "id";

export const nativeFieldType = (
  ds: DatasourceSettings,
  field: { name?: string; type: string; references?: string },
): string =>
  field.name === "id" || referenceIsUuid(ds, field.references)
    ? ds.tsIdType
    : toNative(
        field.type === "datetime" && ds.datetimeRepr === "string"
          ? "string"
          : field.type,
      );

export const referenceFieldShape = (
  idType: string,
): { type: string; size: number | undefined } =>
  REFERENCE_SHAPE[idType] ?? REFERENCE_SHAPE.integer;

export type SystemColumn = {
  name: string;
  type: string;
  isNullable: boolean;
};

/** Inherited StandardDataSource columns — spec types from {@link referenceFieldShape} / the type converter. */
export const systemColumns = (ds: DatasourceSettings): SystemColumn[] => [
  { name: "id", type: referenceFieldShape(ds.idType).type, isNullable: false },
  ...(ds.withUuidColumn
    ? [{ name: "uuid", type: "uuid", isNullable: false }]
    : []),
  { name: "created", type: "datetime", isNullable: false },
  { name: "updated", type: "datetime", isNullable: false },
];

export const declaredFields = <T extends { name: string }>(
  fields: T[],
  ds: DatasourceSettings,
): T[] =>
  ds.withUuidColumn ? fields : fields.filter((f) => f.name !== "uuid");

export const tableFields = <T extends { name: string }>(
  fields: T[],
  ds: DatasourceSettings,
): Array<T | SystemColumn> => {
  const injected = systemColumns(ds);
  const seen = new Set(injected.map((f) => f.name));
  return [
    ...injected,
    ...declaredFields(fields, ds).filter((f) => !seen.has(f.name)),
  ];
};
