import { readFile } from "node:fs/promises";

const resource = (rel: string): Promise<string> =>
  readFile(new URL(`../templates/create-openapi/${rel}`, import.meta.url), "utf8");

export const [openapiTmpl, operationTmpl] = await Promise.all([
  resource("openapi.json.tmpl"),
  resource("operation.json.tmpl"),
]);
