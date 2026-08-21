import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { memoryReader } from "@deterministic-code/generators-common/deterministic-reader";
import type { GenerateEntry } from "@deterministic-code/generators-common/generate-entry";
import { generate } from "./generate-openapi.ts";
import { loadRoutesApi } from "@deterministic-code/generators-common/routes-api-converter";
import { DeterministicParser } from "@deterministic-code/generators-common/specification-parser";
import type { RoutesApiDoc } from "@deterministic-code/generators-common/routes-api";
import { OpenApiConverter } from "./openapi-converter.ts";
import { renderOpenApiFromRoutesApi } from "./openapi-document.ts";

type OpenApiParameter = {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string; format?: string };
};

type OpenApiOperation = {
  operationId?: string;
  requestBody?: unknown;
  parameters?: OpenApiParameter[];
  responses?: Record<string, { description?: string }>;
};

type OpenApiDoc = {
  openapi: string;
  info: { title: string; version: string };
  tags?: { name: string }[];
  paths: Record<string, Record<string, OpenApiOperation | undefined>>;
};

const ifMatchHeader = (
  op: OpenApiOperation | undefined,
): OpenApiParameter | undefined =>
  op?.parameters?.find((p) => p.name === "If-Match" && p.in === "header");

const assertOccWrite = (op: OpenApiOperation | undefined) => {
  const header = ifMatchHeader(op);
  assert.ok(header, "expected If-Match header");
  assert.equal(header.required, true);
  assert.equal(header.schema?.type, "string");
  assert.equal(header.schema?.format, "date-time");
  assert.ok(op?.responses?.["412"]);
  assert.ok(op?.responses?.["428"]);
};

const assertNoOcc = (op: OpenApiOperation | undefined) => {
  assert.equal(ifMatchHeader(op), undefined);
  assert.equal(op?.responses?.["412"], undefined);
  assert.equal(op?.responses?.["428"], undefined);
};

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(hit, `missing ${path}`);
  assert.equal(hit.kind, "content");
  return hit.contents;
};

const loadSample = async (name: string): Promise<Record<string, string>> => {
  const dir = new URL(`./samples/${name}/`, import.meta.url);
  const files = [
    "datasource_types.yaml",
    "view_types.yaml",
    "routes.yaml",
  ] as const;
  const texts = await Promise.all(
    files.map((file) => readFile(new URL(file, dir), "utf8")),
  );
  return {
    "datasource_types.yaml": texts[0]!,
    "view_types.yaml": texts[1]!,
    "routes.yaml": texts[2]!,
  };
};

const generateSample = async (name: string, settings: Record<string, string> = {}) => {
  const files = await loadSample(name);
  const reader = memoryReader(files);
  const entries = await generate({ reader, settings });
  const json = JSON.parse(textOf(entries, "openapi.json")) as OpenApiDoc;
  assert.equal(json.openapi, "3.0.3");
  return { files, json, reader };
};

describe("generate-openapi samples", () => {
  it("1. simple: one entity CRUD catalog", async () => {
    const { json } = await generateSample("01-simple", {
      application_name: "Simple",
      "codegen.schema_version": "1.0",
    });
    assert.equal(json.info.title, "Simple");
    assert.ok(json.paths["/api/users"]);
    assert.ok(json.paths["/api/users/{id}"]);
    assert.equal(json.paths["/api/users"].get?.operationId, "userList");
    assert.equal(json.paths["/api/users"].post?.operationId, "userCreate");
  });

  it("2. moderate: lookup, by-field, custom, and unresolved bodies", async () => {
    const { json } = await generateSample("02-moderate", {
      application_name: "Moderate",
    });
    assert.ok(json.paths["/api/roles"]?.get);
    assert.equal(json.paths["/api/roles"]?.post, undefined);
    assert.ok(json.paths["/api/users/email/{email}"]);
    assert.equal(
      json.paths["/api/users/email/{email}"].get?.operationId,
      "userGetByEmail",
    );
    const ping = json.paths["/api/ping"]?.post;
    assert.equal(ping?.operationId, "ping");
    assert.equal(ping?.requestBody, undefined);
    assertNoOcc(ping);
    const clone = json.paths["/api/users/{id}/clone/{id}"]?.post;
    assert.equal(clone?.operationId, "clone_user");
    assertNoOcc(clone);
    assertNoOcc(json.paths["/api/users/email/{email}"]?.put);
    assertNoOcc(json.paths["/api/users/email/{email}"]?.delete);
  });

  it("3. complex: eager parent-child, nested combined routes, by-name", async () => {
    const { json, reader } = await generateSample("03-complex", {
      application_name: "Complex",
    });
    const routesApi = await loadRoutesApi({ reader, settings: {} });
    assert.ok(json.paths["/api/statuses"]?.get);
    assert.equal(json.paths["/api/statuses"]?.post, undefined);
    assert.ok(json.paths["/api/projects"]);
    assert.ok(json.paths["/api/projects/{id}"]);
    assert.ok(json.paths["/api/projects/name/{name}"]);
    assert.ok(json.paths["/api/projects/{id}/tasks"]);
    assert.ok(json.paths["/api/projects/{id}/tasks/{id}"]);
    assert.ok(routesApi.components.project_eager_body);
    assert.ok(routesApi.components.project_eager_create_body);
    assert.ok(json.paths["/api/projects"]?.post?.requestBody);
  });

  it("4. complex with optimistic concurrency on mutating types", async () => {
    const { files, json } = await generateSample(
      "04-complex-optimistic-concurrency",
      { application_name: "Occ" },
    );
    const types = (
      await DeterministicParser(
        memoryReader({
          "datasource_types.yaml": files["datasource_types.yaml"]!,
        }),
      ).parse({ "datasource.id_type": "integer" })
    ).datasourceTypes;
    assert.equal(
      types.find((t) => t.name === "project")?.optimisticConcurrency,
      true,
    );
    assert.equal(
      types.find((t) => t.name === "task")?.optimisticConcurrency,
      true,
    );
    assert.equal(
      types.find((t) => t.name === "status")?.optimisticConcurrency,
      undefined,
    );
    const projects = json.paths["/api/projects"];
    const project = json.paths["/api/projects/{id}"];
    assertOccWrite(project?.put);
    assertOccWrite(project?.patch);
    assertOccWrite(project?.delete);
    assert.deepEqual(
      project?.put?.parameters?.map((p) => p.name),
      ["id", "If-Match"],
    );
    assertNoOcc(projects?.get);
    assertNoOcc(projects?.post);
    assertNoOcc(project?.get);
    assertOccWrite(json.paths["/api/projects/{id}/tasks/{id}"]?.put);
    assertOccWrite(json.paths["/api/projects/{id}/tasks/{id}"]?.delete);
    assertNoOcc(json.paths["/api/projects/{id}/tasks"]?.post);
    assertNoOcc(json.paths["/api/statuses"]?.get);
  });

  it("documents If-Match only when optimistic concurrency is on", async () => {
    const occOn = new OpenApiConverter().convert({
      version: "1.0.0",
      routes: [
        {
          itemUpdate: {
            path: "/api/items/{id}",
            method: "PUT",
            entity: "item",
            isCustom: false,
            optimisticConcurrency: true,
          },
        },
        {
          itemList: {
            path: "/api/items",
            method: "GET",
            entity: "item",
            isCustom: false,
            optimisticConcurrency: true,
          },
        },
      ],
      components: {},
    });
    const occOnDoc = JSON.parse(occOn) as OpenApiDoc;
    assertOccWrite(occOnDoc.paths["/api/items/{id}"]?.put);
    assertNoOcc(occOnDoc.paths["/api/items"]?.get);

    const { json: occOff } = await generateSample("01-simple", {
      "datasource.use_optimistic_concurrency": "false",
    });
    assertNoOcc(occOff.paths["/api/users/{id}"]?.put);
    assertNoOcc(occOff.paths["/api/users/{id}"]?.patch);
    assertNoOcc(occOff.paths["/api/users/{id}"]?.delete);
  });

  it("uses OpenAPI defaults and skips invalid routes-api entries", async () => {
    const { json } = await generateSample("01-simple");
    assert.equal(json.info.title, "Deterministic Backend API");
    assert.equal(json.info.version, "0.0.0");

    const empty = new OpenApiConverter().convert({
      version: "1.0.0",
      routes: [],
      components: {},
    });
    const emptyDoc = JSON.parse(empty) as OpenApiDoc;
    assert.equal(emptyDoc.info.title, "Deterministic Backend API");
    assert.equal(emptyDoc.tags, undefined);

    const untagged = new OpenApiConverter({ groupByEntity: false }).convert({
      version: "1.0.0",
      routes: [
        {
          userList: {
            path: "/api/users",
            method: "GET",
            entity: "user",
            isCustom: false,
          },
        },
      ],
      components: {},
    });
    const untaggedDoc = JSON.parse(untagged) as OpenApiDoc;
    assert.equal(untaggedDoc.tags, undefined);
    assert.equal(untaggedDoc.paths["/api/users"]?.get?.operationId, "userList");

    const skipped = renderOpenApiFromRoutesApi({
      routesApi: {
        version: "1.0.0",
        routes: [
          { broken: null },
          { also: [] },
          { skip: "not-an-object" },
          {
            health: {
              path: "/api/health",
              method: "GET",
              entity: null,
              isCustom: true,
            },
          },
        ],
        components: {},
      } as RoutesApiDoc,
    });
    const skippedDoc = JSON.parse(skipped) as OpenApiDoc;
    assert.deepEqual(Object.keys(skippedDoc.paths), ["/api/health"]);
  });
});
