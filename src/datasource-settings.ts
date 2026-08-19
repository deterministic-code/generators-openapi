export type Datasource = {
  idType: string;
  uuidRepr: string;
  datetimeRepr: string;
  pluralizeTableNames: boolean;
  useStoredProcedures: boolean;
  useOptimisticConcurrency: boolean;
  withUuidColumn: boolean;
  openApiIdSchema: () => { type: string; format?: string };
  referenceIsUuid: (references: unknown) => boolean;
  referenceFieldShape: () => { type: string; size: number | undefined };
};

const REFERENCE_SHAPE: Record<
  string,
  { type: string; size: number | undefined }
> = {
  integer: { type: "number", size: undefined },
  biginteger: { type: "biginteger", size: undefined },
  uuid: { type: "uuid", size: undefined },
  string: { type: "string", size: 64 },
};

export const datasource = (
  settings: Record<string, string> | undefined = {},
): Datasource => {
  const dict = settings ?? {};
  const idType = dict["datasource.id_type"] ?? "integer";
  const plural = dict["datasource.pluralize_datatable_names"];
  const ds: Datasource = {
    idType,
    uuidRepr: dict["datasource.uuid"] ?? "string",
    datetimeRepr: dict["datasource.datetime"] ?? "native",
    pluralizeTableNames: plural === undefined ? true : plural === "true",
    useStoredProcedures: dict["datasource.use_stored_procedures"] === "true",
    useOptimisticConcurrency:
      dict["datasource.use_optimistic_concurrency"] === "true",
    withUuidColumn: idType !== "uuid",
    openApiIdSchema: () =>
      idType === "uuid"
        ? { type: "string", format: "uuid" }
        : { type: "integer" },
    referenceIsUuid: (references) =>
      idType === "uuid" &&
      typeof references === "string" &&
      references.split(".")[1] === "id",
    referenceFieldShape: () =>
      REFERENCE_SHAPE[idType] ?? REFERENCE_SHAPE.integer,
  };
  return ds;
};

type DatasourceInput = {
  idType?: string;
  uuid?: string;
  datetime?: string;
  pluralizeDatatableNames?: boolean;
  useStoredProcedures?: boolean;
  useOptimisticConcurrency?: boolean;
};

const fromInput = (input: DatasourceInput = {}): Datasource =>
  datasource({
    ...(input.idType === undefined
      ? {}
      : { "datasource.id_type": input.idType }),
    ...(input.uuid === undefined ? {} : { "datasource.uuid": input.uuid }),
    ...(input.datetime === undefined
      ? {}
      : { "datasource.datetime": input.datetime }),
    ...(input.pluralizeDatatableNames === undefined
      ? {}
      : {
          "datasource.pluralize_datatable_names": input.pluralizeDatatableNames
            ? "true"
            : "false",
        }),
    ...(input.useStoredProcedures === undefined
      ? {}
      : {
          "datasource.use_stored_procedures": input.useStoredProcedures
            ? "true"
            : "false",
        }),
    ...(input.useOptimisticConcurrency === undefined
      ? {}
      : {
          "datasource.use_optimistic_concurrency":
            input.useOptimisticConcurrency ? "true" : "false",
        }),
  });

/** Constructible factory for remaining `new DatasourceSettings()` call sites. */
export const DatasourceSettings = fromInput as unknown as {
  new (input?: DatasourceInput): Datasource;
};

export const datasourceSettingsForSettings = (
  settings: Record<string, string>,
): Datasource => datasource(settings);
