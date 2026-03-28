import type { CombatConfig } from "@machine-violet/shared/types/combat.js";

/** Sensible default combat config (D&D-style) */
export function createDefaultConfig(): CombatConfig {
  return {
    initiative_method: "d20_dex",
    round_structure: "individual",
    surprise_rules: true,
  };
}
