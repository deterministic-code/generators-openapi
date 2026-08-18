import {
  camelCase,
  kebabCase,
  pascalCase,
  snakeCase,
} from "change-case";
import pluralize from "pluralize";

export type CaseFormat = "Camel" | "Pascal" | "Snake" | "Kebab" | "Auto";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const toCase = (name: string, format: CaseFormat): string => {
  switch (format) {
    case "Camel":
      return camelCase(name);
    case "Pascal":
      return pascalCase(name);
    case "Snake":
      return snakeCase(name);
    case "Kebab":
      return kebabCase(name);
    default:
      throw new Error(`Unknown case format: ${format}`);
  }
};

export const kebabPlural = (name: string): string => {
  const parts = name.replace(/_/g, "-").split("-");
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]!);
  return parts.join("-");
};
