const KINDS = ["datasource_type", "view_type", "service", "route"];
const NAMESPACES = ["datasource_types"];
const ALLOWED_INTERNAL = new Set([
  "__kind",
  "__ns",
  "__name",
  "true",
  "false",
  "null",
  "undefined",
]);

/** The type descriptor a compiled predicate is applied to: its name (`type == "x"`), its kind (`type is <kind>`), and the namespace it inherits from (`type inherits <ns>`). */
interface FilterCandidate {
  name: string;
  kind: string;
  inheritsNamespace: string;
}

export type FilterPredicate = (cand: FilterCandidate) => boolean;

type PushPlaceholder = (raw: string) => string;
type CompiledExpr = (name: string, kind: string, ns: string) => boolean;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite the `type is/inherits/==` DSL into a JS boolean expression over `__name`/`__kind`/`__ns`, interning the compared literals as placeholders so the ident-safety pass can't mistake them for identifiers. */
function rewriteDslToJs(input: string, push: PushPlaceholder): string {
  let s = input;
  for (const kind of KINDS) {
    const not = `\\btype\\s+is\\s+not\\s+${escapeRegExp(kind)}\\b`;
    s = s.replace(
      new RegExp(not, "g"),
      () => `(__kind !== ${push(JSON.stringify(kind))})`,
    );
  }
  for (const kind of KINDS) {
    const is = `\\btype\\s+is\\s+${escapeRegExp(kind)}\\b`;
    s = s.replace(
      new RegExp(is, "g"),
      () => `(__kind === ${push(JSON.stringify(kind))})`,
    );
  }
  for (const ns of NAMESPACES) {
    const not = `\\btype\\s+inherits\\s+not\\s+${escapeRegExp(ns)}\\b`;
    s = s.replace(
      new RegExp(not, "g"),
      () => `(__ns !== ${push(JSON.stringify(ns))})`,
    );
  }
  for (const ns of NAMESPACES) {
    const inh = `\\btype\\s+inherits\\s+${escapeRegExp(ns)}\\b`;
    s = s.replace(
      new RegExp(inh, "g"),
      () => `(__ns === ${push(JSON.stringify(ns))})`,
    );
  }
  return s.replace(/\btype\s*(==|!=)\s*__STR(\d+)__/g, (_, op, idx) => {
    const jsOp = op === "==" ? "===" : "!==";
    return `(__name ${jsOp} __STR${idx}__)`;
  });
}

function assertKnownIdents(s: string, contextLabel: string): void {
  for (const ident of s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (ident.startsWith("__STR")) continue;
    if (ALLOWED_INTERNAL.has(ident)) continue;
    throw new Error(
      `${contextLabel}: unknown identifier or syntax near "${ident}". Supported: \`type is [not] <kind>\`, \`type inherits [not] <namespace>\`, \`type == "name"\`, logical && / ||, parens. Kinds: ${KINDS.join(", ")}. Namespaces: ${NAMESPACES.join(", ")}.`,
    );
  }
}

function compileExpr(s: string, contextLabel: string): CompiledExpr {
  try {
    return new Function(
      "__name",
      "__kind",
      "__ns",
      `return (${s});`,
    ) as CompiledExpr;
  } catch (e) {
    const err = e as Error;
    throw new Error(
      `${contextLabel} is not a valid expression: ${err.message}`,
    );
  }
}

export function compileFilter(
  filterExpr: string | null | undefined,
  { contextLabel = "filter" }: { contextLabel?: string } = {},
): FilterPredicate {
  if (!filterExpr) return () => true;

  const placeholders: string[] = [];
  const push: PushPlaceholder = (raw) => {
    placeholders.push(raw);
    return `__STR${placeholders.length - 1}__`;
  };

  const withStrings = filterExpr.replace(/"[^"]*"/g, (m) => push(m));
  const rewritten = rewriteDslToJs(withStrings, push);
  assertKnownIdents(rewritten, contextLabel);
  const restored = rewritten.replace(
    /__STR(\d+)__/g,
    (_, idx) => placeholders[Number(idx)],
  );
  const fn = compileExpr(restored, contextLabel);
  return (cand) => Boolean(fn(cand.name, cand.kind, cand.inheritsNamespace));
}

export function compileRoutesFilter(
  filterExpr: string | null | undefined,
): FilterPredicate {
  return compileFilter(filterExpr, { contextLabel: "view_type_routes.filter" });
}
