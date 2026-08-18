import { camelCase } from "change-case";
import { kebabPlural } from "../codegen-naming.ts";
import { computeEnrichmentsForDatasourceType } from "../view-expand.ts";
import type { Enrichment } from "../view-expand.ts";
import type {
  RawFieldEntry,
  RawTypeDef,
  RawTypesDoc,
} from "../deterministic-shapes.ts";
import { indexDatasourceByName as indexDatasource } from "./datasource-index.ts";

/** A single `combined_types` child as authored in a routes doc — either a bare entity name or a `{ name: { via, target, route } }` override map. Keys stay in wire casing. */
interface CombinedChildDef {
  via?: string;
  target?: string;
  route?: string;
}
type CombinedChildEntry = string | Record<string, CombinedChildDef>;

/** One `combined_routes` parent entry body: its own `route` template plus the ordered `combined_types` child list. */
interface CombinedRouteDef {
  route?: string;
  combined_types?: CombinedChildEntry[];
}

/** A parsed routes doc, narrowed to the `combined_routes` list this module walks. */
interface RoutesDoc {
  combined_routes?: Record<string, CombinedRouteDef>[];
}

/** A `combined_types` child after normalization: entity name plus the optional m2m/route overrides resolved to `string | null`. */
interface NormalizedChild {
  name: string;
  via: string | null;
  target: string | null;
  route: string | null;
}

/** The resolved parent axis a child descriptor hangs off of — entity name, rewritten base path, and the `:<parent>Id` param. */
interface ParentContext {
  parentName: string;
  parentBasePath: string;
  parentParam: string;
}

/** A junction table linking a parent and child, with the two FK column names that bridge them. */
interface JunctionMatch {
  name: string;
  parentFk: string;
  childFk: string;
}

/** A many-to-many nested-route descriptor: the child is reached through `junction` via `parentFkField`/`childFkField`. */
interface M2mDescriptor {
  kind: "m2m";
  parent: string;
  parentBasePath: string;
  parentParam: string;
  junction: string;
  target: string;
  targetParam: string;
  parentFkField: string;
  childFkField: string;
  segment: string;
  segmentTail: string;
  collectionPath: string;
  memberPath: string;
}

/** A direct-FK nested-route descriptor: the child owns `fkColumn` pointing back at the parent, plus any body-lookup enrichments. */
interface DirectFkDescriptor {
  kind: "direct-fk";
  parent: string;
  parentBasePath: string;
  parentParam: string;
  child: { name: string };
  fkColumn: string;
  segment: string;
  segmentTail: string;
  collectionPath: string;
  memberPath: string;
  childEnrichments: Enrichment[];
}

/** The descriptor `iterateCombinedRoutes` yields — a discriminated union over the `kind` tag. */
type CombinedRouteDescriptor = M2mDescriptor | DirectFkDescriptor;

interface M2mDescriptorArgs {
  junction: string;
  junctionDef: RawTypeDef | undefined;
  target: string;
  parentFkField: string;
  childFkField: string;
  route: string | null;
}

interface DirectFkDescriptorArgs {
  childName: string;
  fkColumn: string;
  route: string | null;
  childEnrichments: Enrichment[];
}

interface ResolveChildArgs {
  parentCtx: ParentContext;
  child: NormalizedChild;
  byName: Map<string, RawTypeDef>;
  enrichmentsFor: (name: string) => Enrichment[];
}

interface IterateArgs {
  routesData: RoutesDoc;
  datasourceData: RawTypesDoc;
}

function fieldsOf(typeDef: RawTypeDef | undefined): RawFieldEntry[] {
  return Array.isArray(typeDef?.fields) ? typeDef.fields : [];
}

/** An M2M link body validates `<child>_id` as the referenced parent's id type (uuid/integer), which the generators derive from settings. A junction FK with no `references:` has no parent to inherit an id type from, so it is a hard error rather than a silent fallback to number. */
function assertLinkFkHasReferences(
  junctionName: string,
  junctionDef: RawTypeDef | undefined,
  fieldName: string,
): void {
  for (const f of fieldsOf(junctionDef)) {
    const [fname, fdef] = Object.entries(f)[0] ?? [];
    if (fname !== fieldName) continue;
    if (typeof fdef?.references === "string") return;
    break;
  }
  throw new Error(
    `combined_routes: junction "${junctionName}" link FK "${fieldName}" must declare references: <parent>.id — the link-body type derives from the referenced parent's id type`,
  );
}

export function findForeignKeyTo(
  childDef: RawTypeDef,
  parentName: string,
): string | null {
  for (const f of fieldsOf(childDef)) {
    const [fname, fdef] = Object.entries(f)[0] ?? [];
    if (!fdef || typeof fdef.references !== "string") continue;
    const [refTable] = fdef.references.split(".");
    if (refTable === parentName) return fname;
  }
  return null;
}

function parentParamName(parentName: string): string {
  return `${camelCase(parentName)}Id`;
}

function rewriteParentPath(rawPath: string, parentName: string): string {
  return rawPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    return name === "id" ? `:${parentParamName(parentName)}` : `:${name}`;
  });
}

function normalizeCombinedChild(child: CombinedChildEntry): NormalizedChild {
  if (typeof child === "string") {
    return { name: child.replace(/-/g, "_"), via: null, target: null, route: null };
  }
  const [rawName, def] = Object.entries(child)[0];
  return {
    name: rawName.replace(/-/g, "_"),
    via: def && typeof def.via === "string" ? def.via : null,
    target: def && typeof def.target === "string" ? def.target : null,
    route: def && typeof def.route === "string" ? def.route : null,
  };
}

function defaultChildSegment(name: string): string {
  return `/${kebabPlural(name)}`;
}

function detectJunction(
  parentName: string,
  childName: string,
  byName: Map<string, RawTypeDef>,
): JunctionMatch | null {
  const matches: JunctionMatch[] = [];
  for (const [name, def] of byName) {
    if (name === parentName || name === childName) continue;
    const parentFk = findForeignKeyTo(def, parentName);
    const childFk = findForeignKeyTo(def, childName);
    if (parentFk && childFk) matches.push({ name, parentFk, childFk });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const candidates = matches.map((m) => m.name).join(", ");
    throw new Error(
      `combined_routes: ambiguous junction between "${parentName}" and "${childName}" — candidates: ${candidates}. Add via: to disambiguate.`,
    );
  }
  return matches[0];
}

function segmentTailOf(segment: string): string {
  return segment.split("/").filter(Boolean).pop() ?? "";
}

function m2mDescriptor(
  parentCtx: ParentContext,
  {
    junction,
    junctionDef,
    target,
    parentFkField,
    childFkField,
    route,
  }: M2mDescriptorArgs,
): M2mDescriptor {
  assertLinkFkHasReferences(junction, junctionDef, childFkField);
  const segment = route ?? defaultChildSegment(target);
  return {
    kind: "m2m",
    parent: parentCtx.parentName,
    parentBasePath: parentCtx.parentBasePath,
    parentParam: parentCtx.parentParam,
    junction,
    target,
    targetParam: `${camelCase(target)}Id`,
    parentFkField,
    childFkField,
    segment,
    segmentTail: segmentTailOf(segment),
    collectionPath: `${parentCtx.parentBasePath}${segment}`,
    memberPath: `${parentCtx.parentBasePath}${segment}/:${camelCase(target)}Id`,
  };
}

function directFkDescriptor(
  parentCtx: ParentContext,
  { childName, fkColumn, route, childEnrichments }: DirectFkDescriptorArgs,
): DirectFkDescriptor {
  const segment = route ?? defaultChildSegment(childName);
  return {
    kind: "direct-fk",
    parent: parentCtx.parentName,
    parentBasePath: parentCtx.parentBasePath,
    parentParam: parentCtx.parentParam,
    child: { name: childName },
    fkColumn,
    segment,
    segmentTail: segmentTailOf(segment),
    collectionPath: `${parentCtx.parentBasePath}${segment}`,
    memberPath: `${parentCtx.parentBasePath}${segment}/:id`,
    childEnrichments,
  };
}

function explicitM2mDescriptor(
  parentCtx: ParentContext,
  child: NormalizedChild,
  byName: Map<string, RawTypeDef>,
): M2mDescriptor {
  const junctionName = child.via;
  const targetName = child.target;
  if (!junctionName || !targetName) {
    throw new Error(
      `combined_routes: M2M child must declare both via: and target: (parent=${parentCtx.parentName}, child=${child.name})`,
    );
  }
  const junctionDef = byName.get(junctionName);
  if (!junctionDef) {
    throw new Error(
      `combined_routes: junction "${junctionName}" not found in datasource_types.yaml`,
    );
  }
  const parentFkField = findForeignKeyTo(junctionDef, parentCtx.parentName);
  const childFkField = findForeignKeyTo(junctionDef, targetName);
  if (!parentFkField || !childFkField) {
    throw new Error(
      `combined_routes: junction "${junctionName}" missing FK to ${parentCtx.parentName}/${targetName}`,
    );
  }
  return m2mDescriptor(parentCtx, {
    junction: junctionName,
    junctionDef,
    target: targetName,
    parentFkField,
    childFkField,
    route: child.route,
  });
}

function resolveChildDescriptor({
  parentCtx,
  child,
  byName,
  enrichmentsFor,
}: ResolveChildArgs): CombinedRouteDescriptor {
  if (child.via || child.target) {
    return explicitM2mDescriptor(parentCtx, child, byName);
  }
  const childDef = byName.get(child.name);
  if (!childDef) {
    throw new Error(
      `combined_routes: child "${child.name}" not found in datasource_types.yaml`,
    );
  }
  const fkColumn = findForeignKeyTo(childDef, parentCtx.parentName);
  if (fkColumn) {
    return directFkDescriptor(parentCtx, {
      childName: child.name,
      fkColumn,
      route: child.route,
      childEnrichments: enrichmentsFor(child.name).filter(
        (e) => e.fkColumn !== fkColumn,
      ),
    });
  }
  const junction = detectJunction(parentCtx.parentName, child.name, byName);
  if (junction) {
    return m2mDescriptor(parentCtx, {
      junction: junction.name,
      junctionDef: byName.get(junction.name),
      target: child.name,
      parentFkField: junction.parentFk,
      childFkField: junction.childFk,
      route: child.route,
    });
  }
  throw new Error(
    `combined_routes: child "${child.name}" has no FK to parent "${parentCtx.parentName}" and no detectable junction table in datasource_types.yaml`,
  );
}

function makeEnrichmentsFor(
  datasourceData: RawTypesDoc,
): (name: string) => Enrichment[] {
  const cache = new Map<string, Enrichment[]>();
  return (name) => {
    if (!cache.has(name)) {
      cache.set(
        name,
        computeEnrichmentsForDatasourceType(name, datasourceData),
      );
    }
    return cache.get(name)!;
  };
}

export function* iterateCombinedRoutes({
  routesData,
  datasourceData,
}: IterateArgs): Generator<CombinedRouteDescriptor> {
  const byName = indexDatasource(datasourceData) as Map<string, RawTypeDef>;
  const enrichmentsFor = makeEnrichmentsFor(datasourceData);
  for (const entry of routesData?.combined_routes ?? []) {
    const [parentName, def] = Object.entries(entry)[0];
    const parentCtx: ParentContext = {
      parentName,
      parentBasePath: rewriteParentPath(def?.route ?? "", parentName),
      parentParam: parentParamName(parentName),
    };
    for (const rawChild of def?.combined_types ?? []) {
      yield resolveChildDescriptor({
        parentCtx,
        child: normalizeCombinedChild(rawChild),
        byName,
        enrichmentsFor,
      });
    }
  }
}

export function collectCombinedRouteDescriptors({
  routesData,
  datasourceData,
}: IterateArgs): CombinedRouteDescriptor[] {
  return Array.from(iterateCombinedRoutes({ routesData, datasourceData }));
}
