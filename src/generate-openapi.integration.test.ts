import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryReader } from "./common/deterministic-reader.ts";
import type { GenerateEntry } from "./common/generate-entry.ts";
import { generate } from "./generate-openapi.ts";

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
  });

  it("rejects a missing routes.yaml", async () => {
    await assert.rejects(
      () => generate({ reader: memoryReader({}), settings: {} }),
      /routes\.yaml/,
    );
  });
});
