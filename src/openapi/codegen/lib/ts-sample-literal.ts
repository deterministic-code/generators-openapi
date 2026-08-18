import { Buffer } from "node:buffer";

export { SAMPLE_BINARY_BASE64 } from "../../../field-converter.ts";

/** The base64 TypeScript literal for the bytes in `value` — the wire shape of a TS binary field (carried as a base64 string), so a `Uint8Array` fixture renders as a quoted base64 string, not an `ArrayBuffer`. */
function binaryBase64Literal(value: Uint8Array): string {
  return JSON.stringify(Buffer.from(value).toString("base64"));
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** A property-access expression for `key`: dot notation for a legal identifier (`.first_name`), bracket notation otherwise (`["a-b"]`) — so generated get/set assertions address a field whatever its wire name. */
export function accessExpr(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

/** A raw TypeScript expression generated verbatim (e.g. a template literal `` `sample-${randSuffix()}` ``) instead of being JSON-stringified. */
export class RawTsExpr {
  source: string;
  constructor(source: string) {
    this.source = source;
  }
}

/** A field value the generated test computes AT RUNTIME rather than freezing to a fake literal — so tests exercise real uuids/timestamps and never assert against hardcoded placeholders like `00000000-…-0001` or `2024-01-01T00:00:00.000Z`. Language-neutral: each language's literal-renderer maps it to that language's call. `datetime` picks Date vs ISO string; `size` bounds a random string to maxLength. */
export class RuntimeValue {
  kind: string;
  datetime: string;
  size: number | undefined;
  constructor(
    kind: string,
    { datetime = "native", size }: { datetime?: string; size?: number } = {},
  ) {
    this.kind = kind;
    this.datetime = datetime;
    this.size = size;
  }
}

/** The TypeScript runtime expression for a {@link RuntimeValue} — the source text baked into the generated test (stable across generates; only its per-run result varies). */
function runtimeValueTs(value: RuntimeValue): string {
  switch (value.kind) {
    case "uuid":
      return "crypto.randomUUID()";
    case "datetime":
      return value.datetime === "native"
        ? "new Date()"
        : "new Date().toISOString()";
    case "date":
      return "new Date().toISOString().slice(0, 10)";
    case "email":
      return "`${crypto.randomUUID()}@example.com`";
    case "string":
      return Number.isFinite(value.size)
        ? `crypto.randomUUID().slice(0, ${value.size})`
        : "crypto.randomUUID()";
    default:
      throw new Error(
        `runtimeValueTs: unmapped kind ${JSON.stringify(value.kind)}`,
      );
  }
}

/** A TS source expression for a value guaranteed to differ AT RUNTIME from `value` — the setter target in a get/set test, so `x.f = next; expect(x.f).toEqual(next)` actually proves the assignment took effect instead of being a no-op when `next === initial`. uuid/string/email differ by an independent random draw; number/boolean/datetime are derived to differ deterministically. */
export function distinctNextTs(value: unknown): string {
  if (value instanceof RuntimeValue) {
    if (value.kind === "datetime") {
      return value.datetime === "native"
        ? "new Date(Date.now() + 86400000)"
        : "new Date(Date.now() + 86400000).toISOString()";
    }
    if (value.kind === "date") {
      return "new Date(Date.now() + 86400000).toISOString().slice(0, 10)";
    }
    return runtimeValueTs(value);
  }
  if (typeof value === "number") return String(value + 1);
  if (typeof value === "bigint") return `${value + 1n}n`;
  if (typeof value === "boolean") return String(!value);
  if (value instanceof Uint8Array)
    return binaryBase64Literal(new Uint8Array([255]));
  if (typeof value === "string") return JSON.stringify(`${value}-next`);
  return serializeSampleValue(value);
}

// Non-container values (markers, scalars, Date, bytes) serialize the same regardless of key style; returns null when `value` is an array/object the caller must walk.
function serializeLeaf(value: unknown): string | null {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof RawTsExpr) return value.source;
  if (value instanceof RuntimeValue) return runtimeValueTs(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) {
    return `new Date(${JSON.stringify(value.toISOString())})`;
  }
  if (value instanceof Uint8Array) return binaryBase64Literal(value);
  if (typeof value === "object") return null;
  return JSON.stringify(value);
}

/** Serialize a sampled JS value to its TypeScript source literal — shared by every self-contained test generator. Generates `RawTsExpr`/`RuntimeValue` verbatim as runtime source, and handles bigint, Date, Uint8Array, arrays, and plain objects. `jsonKeys` quotes every object key (the route-e2e/service-integration `tsLiteral` shape); the default uses bare identifiers where legal. */
export function serializeSampleValue(
  value: unknown,
  opts: { jsonKeys?: boolean } = {},
): string {
  const leaf = serializeLeaf(value);
  if (leaf !== null) return leaf;
  const rec = (v: unknown): string => serializeSampleValue(v, opts);
  if (Array.isArray(value)) return `[${value.map(rec).join(", ")}]`;
  const keyOf = (k: string): string =>
    opts.jsonKeys === true ? JSON.stringify(k) : safeKey(k);
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${keyOf(k)}: ${rec(v)}`)
    .join(", ");
  return `{ ${entries} }`;
}

/** `serializeSampleValue` with every object key quoted — the shape the route-e2e and service-integration generators generate. */
export function tsLiteral(value: unknown): string {
  return serializeSampleValue(value, { jsonKeys: true });
}
