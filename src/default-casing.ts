import {
  CasingFactory,
  LANGUAGE_CASING_DEFAULTS,
  casingOverridesFromSettings,
  type ICasingStrategy,
  type LanguageCasingDefaults,
} from "@deterministic-code/generators-common/casing-strategy";

export const GENERATOR_LANGUAGE = "openapi";

export const DEFAULT_CASING: LanguageCasingDefaults =
  LANGUAGE_CASING_DEFAULTS.openapi;

export type PackCasing = ICasingStrategy;

/** Language defaults + settings overrides. Generators call this — not a shared paths.ts. */
export const createCasing = (
  settings: Record<string, string>,
): PackCasing =>
  CasingFactory.create(
    GENERATOR_LANGUAGE,
    casingOverridesFromSettings(settings, GENERATOR_LANGUAGE),
  );

export const defaultCasing = createCasing;
