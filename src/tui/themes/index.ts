export type {
  ThemeComponent,
  ComponentName,
  ThemeAsset,
  ThemeColorMap,
  SwatchConfig,
  StyleVariant,
  VariantOverride,
  ThemeDefinition,
  ResolvedTheme,
} from "./types.js";
export { REQUIRED_COMPONENTS } from "./types.js";

export { parseThemeAsset } from "./parser.js";

export type { ComposedFrame } from "./composer.js";
export {
  tileToWidth,
  composeTopFrame,
  composeBottomFrame,
  composeSimpleBorder,
  composeSideColumn,
  composeTurnSeparator,
} from "./composer.js";

export {
  loadBuiltinTheme,
  loadCustomTheme,
  listBuiltinThemes,
  resetThemeCache,
} from "./loader.js";

export { resolveTheme } from "./resolver.js";

export {
  BUILTIN_DEFINITIONS,
  getBuiltinDefinition,
  listBuiltinDefinitions,
} from "./builtin-definitions.js";

export { themeToVariant } from "./compat.js";
