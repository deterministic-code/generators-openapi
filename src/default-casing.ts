import {
  createCasingStrategy,
  type ICasingStrategy,
} from "@deterministic-code/generators-common/casing-strategy";

export const GENERATOR_LANGUAGE = "openapi";

export type PackCasing = ICasingStrategy;

/** Language defaults + settings overrides. Generators call this — not a shared paths.ts. */
export const createCasing = (
  settings: Record<string, string>,
): PackCasing => createCasingStrategy(GENERATOR_LANGUAGE, settings);

export const defaultCasing = createCasing;
