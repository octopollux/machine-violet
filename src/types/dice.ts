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
