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
 * `mode` does NOT change during the setup-agent conversation — the engine
 * only broadcasts `session:mode` events for OOC/dev entry/exit, so `mode`
 * stays "play" throughout setup. The signal that you're in setup is
 * `currentTurn.campaignId === "__setup__"` (a synthetic campaign id used
 * for the setup session). `transitionCampaignId` briefly holds the new
 * campaign id during the setup → live-campaign handoff. See
 * `docs/e2e-harness.md` "Engine-state surprises" for the full list.
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
