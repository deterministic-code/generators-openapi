/** Spec field type → TypeScript type. */
export const to: Record<string, string> = {
  string: "string",
  character: "string",
  number: "number",
  integer: "number",
  unsignedinteger: "number",
  smallinteger: "number",
  unsignedsmallinteger: "number",
  biginteger: "number",
  unsignedbiginteger: "number",
  float: "number",
  decimal: "string",
  boolean: "boolean",
  datetime: "Date",
  binary: "string",
  uuid: "string",
  reference: "number",
};

/** TypeScript type → canonical spec field type. */
export const from: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  Date: "datetime",
};

/** Spec field type → base Zod expression (before size/nullability tighteners). */
const ZOD: Record<string, string> = {
  string: "z.string()",
  character: "z.string()",
  decimal: "z.string()",
  number: "z.number()",
  integer: "z.number()",
  smallinteger: "z.number()",
  float: "z.number()",
  reference: "z.number()",
  biginteger: "z.number()",
  boolean: "z.boolean()",
  binary: "z.string().base64()",
  uuid: "z.string().uuid()",
};

/** `datasource.id_type` → TypeScript id type. */
const ID_NATIVE: Record<string, string> = {
  integer: "number",
  biginteger: "bigint",
  uuid: "string",
  string: "string",
};

/** `datasource.id_type` → Zod id expression. */
const ID_ZOD: Record<string, string> = {
  integer: "z.number().int().nonnegative()",
  biginteger: "z.bigint()",
  uuid: "z.string().uuid()",
  string: "z.string()",
};

export const toNative = (specType: string): string => {
  const native = to[specType];
  if (native === undefined) {
    throw new Error(`Unknown spec field type: ${specType}`);
  }
  return native;
};

export const fromNative = (nativeType: string): string => {
  const spec = from[nativeType];
  if (spec === undefined) {
    throw new Error(`Unknown native type: ${nativeType}`);
  }
  return spec;
};

export const toZod = (specType: string, datetimeRepr: string): string => {
  if (specType === "datetime") {
    return datetimeRepr === "native" ? "z.date()" : "z.string()";
  }
  const expr = ZOD[specType];
  if (expr === undefined) {
    throw new Error(`Unknown datasource field type: ${specType}`);
  }
  return expr;
};

export const idTypeToNative = (idType: string): string =>
  ID_NATIVE[idType] ?? ID_NATIVE.integer;

export const idTypeToZod = (idType: string): string =>
  ID_ZOD[idType] ?? ID_ZOD.integer;
