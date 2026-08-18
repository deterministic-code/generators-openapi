import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "./common/deterministic-reader.ts";
import type { GenerateEntry } from "./common/generate-entry.ts";
import { generate } from "./generate-openapi.ts";
import { RoutesApiConverter } from "./routes-api-converter.ts";

const textOf = (entries: GenerateEntry[], path: string): string => {
  const hit = entries.find((e) => e.kind === "content" && e.filename === path);
  assert.ok(hit, `missing ${path}`);
  assert.equal(hit.kind, "content");
  return hit.contents;
};

const fixtures = {
  "datasource_types.yaml": `types:
  - user:
      fields:
        - email:
            type: string
`,
  "view_types.yaml": `includes:
  - datasource_types:
      include: "*"
types: []
`,
  "routes.yaml": `includes:
  - view_type_routes:
      filter: 'type is view_type || type is datasource_type'
routes: []
`,
};

describe("generate-openapi", () => {
  it("emits openapi.json for route candidates", async () => {
    const entries = await generate({
      reader: memoryReader(fixtures),
      settings: {
        application_name: "Demo",
        "codegen.schema_version": "2.0",
      },
    });
    const json = JSON.parse(textOf(entries, "openapi.json")) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
    };
    assert.equal(json.openapi, "3.0.3");
    assert.equal(json.info.title, "Demo");
    assert.equal(json.info.version, "2.0");
    assert.ok(json.paths["/api/users"]);
    assert.deepEqual(
      entries.filter((e) => e.kind === "content").map((e) => e.filename),
      ["openapi.json"],
    );
  });

  it("projects OpenAPI from the routes-api IR", async () => {
    const routesApi = await new RoutesApiConverter().fromReader({
      reader: memoryReader(fixtures),
      settings: {},
    });
    assert.equal(routesApi.version, "1.0.0");
    assert.ok(routesApi.components.user);
    assert.equal(
      (routesApi.components as { schemas?: unknown }).schemas,
      undefined,
    );
    const list = routesApi.routes.find(
      (entry) =>
        entry !== null && typeof entry === "object" && "userList" in entry,
    ) as {
      userList: {
        path: string;
        method: string;
        entity: string;
        isCustom: boolean;
        response: { name: string; schema: { $ref: string } | null };
      };
    };
    assert.equal(list.userList.path, "/api/users");
    assert.equal(list.userList.method, "GET");
    assert.equal(list.userList.entity, "user");
    assert.equal(list.userList.isCustom, false);
    assert.equal(list.userList.response.name, "user");
    assert.equal(
      list.userList.response.schema?.$ref,
      "#/components/schemas/user",
    );
  });

  it("rejects a missing routes.yaml", async () => {
    await assert.rejects(
      () => generate({ reader: memoryReader({}), settings: {} }),
      /routes\.yaml/,
    );
  });
});
