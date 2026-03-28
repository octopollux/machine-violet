/** A single parsed dice expression component */
export interface DiceExpression {
  count: number;
  sides: number | "F"; // "F" for FATE dice
  keep?: { highest?: number; lowest?: number };
  exploding?: boolean;
  successThreshold?: number; // count dice >= this value
  modifier: number;
}

/** Input to the roll_dice tool */
export interface RollDiceInput {
  expression: string;
  reason?: string;
  display?: boolean;
  claimed_result?: {
    rolls: number[];
    total: number;
  };
}

/** Result of a single dice expression */
export interface DiceRollResult {
  expression: string;
  rolls: number[];
  kept?: number[];
  modifier: number;
  total: number;
  successes?: number;
  reason?: string;
}

/** Full result of a roll_dice call (may contain multiple expressions) */
export interface RollDiceOutput {
  results: DiceRollResult[];
}

// --- Custom-face dice (Genesys, Year Zero, narrative systems) ---

/**
 * A custom die definition: named faces with symbol strings.
 * Example Genesys Boost die: { name: "boost", faces: ["", "", "success", "success+advantage", "advantage+advantage", "advantage"] }
 * Symbols are free-form strings — the game system's rule card defines their meaning.
 */
export interface CustomDieDefinition {
  name: string;
  faces: string[];
}

/** Result of rolling custom-face dice. */
export interface CustomDiceResult {
  die: string;           // die definition name
  count: number;         // how many were rolled
  faces: string[];       // the face that came up on each die
  symbols: Record<string, number>; // aggregated symbol counts
}
