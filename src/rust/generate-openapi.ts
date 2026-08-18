import { fill } from "../common/fill.ts";
import type { GenerateContext } from "../common/generate-context.ts";
import { content, type GenerateEntry } from "../common/generate-entry.ts";
import { settingsStr } from "../common/settings.ts";
import { generate as generateJson } from "../generate-openapi.ts";
import { conformanceTmpl, routerTmpl } from "./resources/openapi.ts";

const escapeRustStringLiteral = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export const generate = async (
  ctx: GenerateContext,
): Promise<GenerateEntry[]> => {
  const crateName =
    settingsStr(ctx.settings, "languages.rust.crate_name") ?? "consumer";
  const jsonEntry = (await generateJson(ctx)).find(
    (entry) => entry.kind === "content" && entry.filename === "openapi.json",
  );
  if (jsonEntry === undefined || jsonEntry.kind !== "content") {
    throw new Error("openapi json lane did not emit openapi.json");
  }
  const spec = JSON.parse(jsonEntry.contents) as {
    paths?: Record<string, unknown>;
  };
  const expectedPaths = Object.keys(spec.paths ?? {})
    .sort()
    .map((p) => `        ${JSON.stringify(p)},`)
    .join("\n");
  return [
    content(
      "openapi.rs",
      fill(routerTmpl, {
        specJson: escapeRustStringLiteral(jsonEntry.contents.trim()),
      }),
    ),
    content(
      "openapi_conformance.rs",
      fill(conformanceTmpl, {
        crateModule: crateName.replace(/-/g, "_"),
        expectedPaths,
      }),
    ),
  ];
};
