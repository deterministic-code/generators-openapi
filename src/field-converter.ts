import {
  EMPTY_UUID,
  hexToBytes,
  parseDefaultToken,
} from "./common/default-token.ts";
import {
  nativeTypeFor,
  renderSqlDefault,
  type ConverterField,
  type ConverterModule,
} from "./field-converters/base.ts";
import { to, toNative } from "./common/type-converter.ts";

export type { ConverterField, ConverterModule };

/** The base64 sample a `binary` field takes on the TypeScript wire — binary is carried as a base64 string in a `format: byte` body, so the sampler generates a base64 string literal, not an `ArrayBuffer`. The canonical home; `ts-sample-literal.ts` re-exports it. */
export const SAMPLE_BINARY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAA==";

/** The converter type keys that carry a numeric sample value (a `0` template, a `1` json sample). */
export const NUMERIC_TYPES = new Set([
  "integer",
  "biginteger",
  "smallinteger",
  "number",
  "float",
]);

type DefaultArg = string | boolean;

function dq(value: string | boolean | undefined): string {
  return JSON.stringify(String(value));
}

/** TypeScript field converter: datasource_type → TS type + default-token literal/expression. */
export const fieldConverter = {
  target: "typescript",
  targetKind: "language" as const,
  datetimeStringType: "string",
  datetimeStringDefault: "new Date().toISOString()",
  conversions: Object.entries(to).map(([type, native]) => ({ type, native })),
  defaults: {
    Now: () => "new Date()",
    UtcNow: () => "new Date()",
    NewId: () => "crypto.randomUUID()",
    Empty: () => dq(EMPTY_UUID),
    Uuid: (a?: DefaultArg) => dq(a),
    DateTime: (a?: DefaultArg) => `new Date(${dq(a)})`,
    Hex: (a?: DefaultArg) =>
      `new Uint8Array([${hexToBytes(a as string).join(", ")}]).buffer`,
    Boolean: (a?: DefaultArg) => (a ? "true" : "false"),
    Numeric: (a?: DefaultArg) => a as string,
    String: (a?: DefaultArg) => dq(a),
  },
  newIdSample: () => "crypto.randomUUID()",
  newStringSample: (max?: number) =>
    typeof max === "number" && Number.isFinite(max)
      ? `crypto.randomUUID().slice(0, ${max})`
      : "crypto.randomUUID()",
  jsonSample: {
    string: `"sample"`,
    character: `"sample"`,
    uuid: dq(EMPTY_UUID),
    number: "1",
    integer: "1",
    smallinteger: "1",
    biginteger: "1",
    unsignedinteger: "1",
    unsignedsmallinteger: "1",
    unsignedbiginteger: "1",
    reference: "1",
    float: "1.0",
    decimal: `"0"`,
    boolean: "false",
    datetime: `"2024-01-01T00:00:00.000Z"`,
    date: `"2024-01-01"`,
    email: `"sample@example.com"`,
    binary: JSON.stringify(SAMPLE_BINARY_BASE64),
  },
  jsonNext: {
    string: `"sample-next"`,
    character: `"sample-next"`,
    uuid: dq("00000000-0000-0000-0000-000000000001"),
    number: "2",
    integer: "2",
    smallinteger: "2",
    biginteger: "2",
    unsignedinteger: "2",
    unsignedsmallinteger: "2",
    unsignedbiginteger: "2",
    reference: "2",
    float: "2.0",
    decimal: `"1"`,
    boolean: "true",
    datetime: `"2024-01-02T00:00:00.000Z"`,
    date: `"2024-01-02"`,
    email: `"next@example.com"`,
    binary: JSON.stringify("AQIDBAUGBwgJCgsMDQ4PEA=="),
  },
  numericLiteral: {
    number: (value) => String(value),
    bigint: (value) => `${value}n`,
  },
} satisfies ConverterModule;

export default fieldConverter;

/** The language literal/expression for a spec field's `{ type, value }` default — `null` when absent. Datetime honors the string representation so a `z.string()` field gets an ISO string, not a native date. */
const defaultLiteralFor = (
  mod: ConverterModule,
  field: { type: string; value: string | boolean | number | null | undefined },
  datetimeRepr: string,
): string | null => {
  const { token, arg } = parseDefaultToken(field.type, field.value);
  if (token === "None") return null;
  if (field.type === "datetime" && datetimeRepr === "string") {
    if (token === "Now" || token === "UtcNow") {
      return mod.datetimeStringDefault ?? mod.defaults[token]();
    }
    return dq(arg);
  }
  if (field.type === "decimal") return mod.defaults.String(arg);
  const render = mod.defaults[token];
  if (!render) {
    throw new Error(
      `${mod.target} converter cannot render default token "${token}"`,
    );
  }
  return render(arg);
};

interface ConverterRegistration {
  kind: string;
  target_kind: "language" | "dialect";
  target: string;
}

interface ConverterCatalog {
  converters: ConverterRegistration[];
}

export class FieldConverter {
  #mod: ConverterModule;
  #datetimeRepr: string;

  constructor(mod: ConverterModule = fieldConverter, datetimeRepr = "native") {
    this.#mod = mod;
    this.#datetimeRepr = datetimeRepr;
  }

  nativeType(field: ConverterField): string {
    return this.#mod.targetKind === "language"
      ? toNative(
          field.type === "datetime" && this.#datetimeRepr === "string"
            ? "string"
            : field.type,
        )
      : nativeTypeFor(this.#mod, field);
  }

  defaultExpression(field: ConverterField): string | null {
    return this.#mod.targetKind === "dialect"
      ? renderSqlDefault(this.#mod, field)
      : defaultLiteralFor(
          this.#mod,
          { type: field.type, value: field.defaultValue },
          this.#datetimeRepr,
        );
  }

  defaultLiteral(
    type: string,
    value: string | boolean | number | null,
  ): string | null {
    return defaultLiteralFor(this.#mod, { type, value }, this.#datetimeRepr);
  }

  /** The JSON body value a POST e2e test sends for a field of this type — the target's wire representation. */
  jsonSample(field: ConverterField): string {
    return this.#mappedLiteral("jsonSample", field);
  }

  /** A second JSON literal distinct from {@link jsonSample} — the setter target in get/set tests. */
  jsonNext(field: ConverterField): string {
    return this.#mappedLiteral("jsonNext", field);
  }

  /**
   * Language literals for a field accessor test: `sample` matches `nativeType`, `next` differs
   * so `value.f = next` is not a no-op. `Date` wraps the datetime JSON samples; `bigint` uses
   * {@link numericLiteralForNative}.
   */
  samples(
    field: ConverterField,
    nativeType: string = this.nativeType(field),
  ): { sample: string; next: string } {
    if (nativeType === "bigint") {
      const sample = this.numericLiteralForNative(nativeType, 1);
      const next = this.numericLiteralForNative(nativeType, 2);
      if (sample === null || next === null) {
        throw new Error(
          `no bigint numericLiteral for ${this.#mod.targetKind} "${this.#mod.target}"`,
        );
      }
      return { sample, next };
    }
    const sample = this.jsonSample(field);
    const next = this.jsonNext(field);
    if (nativeType === "Date") {
      return { sample: `new Date(${sample})`, next: `new Date(${next})` };
    }
    return { sample, next };
  }

  #mappedLiteral(
    table: "jsonSample" | "jsonNext",
    field: ConverterField,
  ): string {
    const map = this.#mod[table];
    if (!map) {
      throw new Error(
        `no ${table} map registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    const sample = map[field.type];
    if (sample === undefined) {
      throw new Error(
        `no ${table} for field type "${field.type}" (${this.#mod.target})`,
      );
    }
    return sample;
  }

  /** The generated wire value for a `<type>` field. A `unique` `uuid`/`string`/`character` uses the fresh-sample hooks so repeated inserts never collide. */
  generatedSample(field: ConverterField, { unique = false } = {}): string {
    if (unique && field.type === "uuid") {
      return this.#freshSample("newIdSample");
    }
    if (unique && (field.type === "string" || field.type === "character")) {
      const gen = this.#mod.newStringSample;
      if (!gen) {
        throw new Error(
          `no newStringSample generator registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
        );
      }
      return gen(typeof field.size === "number" ? field.size : undefined);
    }
    return this.jsonSample(field);
  }

  #freshSample(hook: "newIdSample"): string {
    const gen = this.#mod[hook];
    if (!gen) {
      throw new Error(
        `no ${hook} generator registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    return gen();
  }

  /** The plain response-example value a field of `type` takes in a generated OpenAPI response template. */
  templateSample(type: string): unknown {
    if (type === "datetime") return "2026-01-01T00:00:00Z";
    if (type === "uuid") return EMPTY_UUID;
    if (type === "binary") return "";
    if (type === "boolean") return false;
    if (NUMERIC_TYPES.has(type)) return 0;
    return "string";
  }

  /** The plain (unquoted) sample value a field of `type` takes — the raw-value form of `jsonSample`. */
  rawSample(
    type: string,
    index: number,
    {
      maxLength,
      minLength = 0,
    }: { maxLength?: number; minLength?: number } = {},
  ): unknown {
    if (type === "datetime") return "2024-01-01T00:00:00.000Z";
    if (type === "date") return "2024-01-01";
    if (type === "uuid") return EMPTY_UUID;
    if (type === "binary") return SAMPLE_BINARY_BASE64;
    if (type === "email") return `sample-${index}@example.com`;
    const candidate = `sample-${index}`;
    if (typeof maxLength === "number" && candidate.length > maxLength) {
      return "x".repeat(Math.max(minLength, Math.min(maxLength, 1)));
    }
    if (minLength > 0 && candidate.length < minLength) {
      return candidate + "x".repeat(minLength - candidate.length);
    }
    return candidate;
  }

  numericLiteralForNative(nativeType: string, value: number): string | null {
    const table = this.#mod.numericLiteral;
    if (!table) {
      throw new Error(
        `no numericLiteral table registered for ${this.#mod.targetKind} "${this.#mod.target}"`,
      );
    }
    const render = table[nativeType];
    return render ? render(value) : null;
  }

  numericLiteral(field: ConverterField, value: number): string | null {
    return this.numericLiteralForNative(this.nativeType(field), value);
  }
}

/** Resolve the TypeScript generate-time converter — other languages live in their own generator packs. */
export function fieldConverterFor({
  targetKind,
  target,
  catalog,
  datetimeRepr,
}: {
  targetKind: "language" | "dialect";
  target: string;
  catalog: ConverterCatalog;
  datetimeRepr?: string;
}): FieldConverter {
  const registered = catalog.converters.find(
    (c) =>
      c.kind === "generate" &&
      c.target_kind === targetKind &&
      c.target === target,
  );
  if (!registered) {
    throw new Error(
      `no generate field converter registered for ${targetKind} "${target}"`,
    );
  }
  if (target !== "typescript" || targetKind !== "language") {
    throw new Error(`no field-converter module for ${targetKind} "${target}"`);
  }
  return new FieldConverter(fieldConverter, datetimeRepr);
}
