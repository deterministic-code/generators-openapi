const ID_TS: Record<string, string> = {
  integer: "number",
  biginteger: "bigint",
  uuid: "string",
  string: "string",
};
const ID_RUST: Record<string, string> = {
  integer: "i64",
  biginteger: "i64",
  uuid: "uuid::Uuid",
  string: "String",
};
const ID_ZOD: Record<string, string> = {
  integer: "z.number().int().nonnegative()",
  biginteger: "z.bigint()",
  uuid: "z.string().uuid()",
  string: "z.string()",
};
const ID_CSHARP: Record<string, string> = {
  integer: "int",
  smallinteger: "short",
  biginteger: "long",
  uuid: "System.Guid",
  string: "string",
};

interface ReferenceShape {
  type: string;
  size: number | undefined;
}

/** The datasource field/column shape a `references: X.id` FK inherits from its parent primary key under each id_type — the abstract type the implicit `id` itself presents, so a type-less FK generates identically to the id it points at. Integer ids present as `number` (i64/number, matching `ID_RUST.integer`/`ID_TS.integer` and the sample convention), NOT `integer` (i32); both map to the same SQL column, but only `number` matches the id's cross-lane field type. */
const REFERENCE_SHAPE: Record<string, ReferenceShape> = {
  integer: { type: "number", size: undefined },
  biginteger: { type: "biginteger", size: undefined },
  uuid: { type: "uuid", size: undefined },
  string: { type: "string", size: 64 },
};

const UUID_SENTINEL = "00000000-0000-0000-0000-000000000000";
const SAMPLE_UUID = "00000000-0000-0000-0000-000000000001";
const INT_SENTINEL = "99999";
const DEFAULTS = { idType: "integer", uuid: "string", datetime: "native" };

interface DatasourceInput {
  idType?: string;
  uuid?: string;
  datetime?: string;
  pluralizeDatatableNames?: boolean;
  useStoredProcedures?: boolean;
  useOptimisticConcurrency?: boolean;
}

/** The resolved `settings.datasource` block plus every representation derived from it (id / uuid-column / datetime), so no generator re-derives `idType !== "uuid"`, an id→type map, a FK-reference coercion, or a missing-id sentinel. Construct from loader-resolved settings via `datasourceSettingsForSettings`; `datasourceSettingsFor(opts)` is the direct-call/test adapter. */
export class DatasourceSettings {
  idType: string;
  uuidRepr: string;
  datetimeRepr: string;
  pluralizeTableNames: boolean;
  useStoredProcedures: boolean;
  useOptimisticConcurrency: boolean;

  constructor(datasource: DatasourceInput = {}) {
    this.idType = datasource.idType ?? DEFAULTS.idType;
    this.uuidRepr = datasource.uuid ?? DEFAULTS.uuid;
    this.datetimeRepr = datasource.datetime ?? DEFAULTS.datetime;
    this.pluralizeTableNames = datasource.pluralizeDatatableNames !== false;
    this.useStoredProcedures = datasource.useStoredProcedures === true;
    this.useOptimisticConcurrency =
      datasource.useOptimisticConcurrency === true;
  }

  get isUuid(): boolean {
    return this.idType === "uuid";
  }

  /** A uuid primary key IS the uuid, so no separate system `uuid` column is carried. */
  get withUuidColumn(): boolean {
    return this.idType !== "uuid";
  }

  get isNativeDatetime(): boolean {
    return this.datetimeRepr !== "string";
  }

  /** OpenAPI schema for the implicit `id` primary key and for `{id}` / `*Id` path params. */
  openApiIdSchema(): { type: string; format?: string } {
    return this.isUuid
      ? { type: "string", format: "uuid" }
      : { type: "integer" };
  }

  tsIdType(): string {
    return ID_TS[this.idType] ?? "number";
  }

  rustIdType(): string {
    return ID_RUST[this.idType] ?? "i64";
  }

  zodIdType(): string {
    return ID_ZOD[this.idType] ?? ID_ZOD.integer;
  }

  csharpIdType(): string {
    return ID_CSHARP[this.idType] ?? "int";
  }

  /** True when a `references: X.id` FK inherits a uuid from its parent primary key (so it is NOT its authored `type: number`). Only implicit `.id` targets coerce; a FK to a non-PK column keeps its declared type. */
  referenceIsUuid(references: unknown): boolean {
    return (
      this.isUuid &&
      typeof references === "string" &&
      references.split(".")[1] === "id"
    );
  }

  /** The `{ type, size }` a `references:` FK takes from the parent primary key it points at — the canonical reference-resolution the SQL DDL and the schema/OpenAPI layers share. */
  referenceFieldShape(): ReferenceShape {
    return REFERENCE_SHAPE[this.idType] ?? REFERENCE_SHAPE.integer;
  }

  /** An id value that no seeded row will hold — for the "missing row → 404" test branches. */
  missingIdSentinel(): string {
    return this.isUuid ? UUID_SENTINEL : INT_SENTINEL;
  }

  /** A representative, format-valid `id` value under this id_type — a nonnegative integer, a bigint, a uuid string, or a plain string. Fixtures (which must parse the generated `id` schema) and route `{id}` path smoke tests (which must clear path-param validation rather than 400 on a numeric-vs-uuid mismatch) both derive their sample id here, so the id shape is settings-driven in one place. */
  sampleId(): string | bigint | number {
    switch (this.idType) {
      case "uuid":
        return SAMPLE_UUID;
      case "biginteger":
        return BigInt(1);
      case "string":
        return "1";
      default:
        return 1;
    }
  }
}
