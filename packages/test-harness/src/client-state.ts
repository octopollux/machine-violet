/**
 * Narrow type for the ClientState the sidecar exposes via GET /state.
 *
 * We deliberately don't import @machine-violet/client-ink's full ClientState:
 * the harness should be deployable as a thin tool with minimal dependencies.
 * Only the fields used by scenarios appear here. If a scenario needs more,
 * widen this type.
 */

export interface Choice {
  /** Display label of the choice. */
  label?: string;
  /** Some choice shapes use `text` instead of `label`. */
  text?: string;
}

export interface ActiveChoices {
  id?: string;
  prompt?: string;
  choices: (string | Choice)[];
  descriptions?: (string | null)[];
}

export interface Turn {
  id: string;
  seq: number;
  status: "open" | "processing" | "resolved";
  activePlayers?: string[];
  /** "__setup__" during the new-campaign conversation, real campaign id otherwise. */
  campaignId?: string;
}

export interface NarrativeLine {
  kind: "dm" | "player" | "system" | string;
  text: string;
}

/**
 * Subset of the engine's ClientState that scenarios poll.
 *
 * `engineState` transitions are the primary signal for "phase progression":
 *   null → "starting_session" → "dm_thinking" → "waiting_input" → ...
 *
 * `mode` toggles between "setup" (campaign-creation conversation) and "play"
 * (live campaign). `transitionCampaignId` briefly holds the new campaign id
 * during the setup → play handoff.
 */
export interface ClientStateSnapshot {
  engineState: string | null;
  engineStateSince: number | null;
  mode: "play" | "ooc" | "dev" | "setup";
  variant: string | null;
  narrativeLines: NarrativeLine[];
  currentTurn: Turn | null;
  activeChoices: ActiveChoices | null;
  transitionCampaignId: string | null;
  transitionCampaignName: string | null;
  sessionEnded: boolean;
  sessionStale: boolean;
  lastError: { message: string; recoverable: boolean } | null;
}

/** Extract the display label from a choice that may be a string or { label }. */
export function choiceLabel(c: string | Choice): string {
  if (typeof c === "string") return c;
  return c.label ?? c.text ?? "";
}
