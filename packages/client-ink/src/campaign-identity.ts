/**
 * Which campaign the playing phase is currently rendering.
 *
 * The playing phase renders before the server's first `state:snapshot`
 * arrives — and the new-campaign setup conversation never gets one at all —
 * so the client keeps its own copy of "what am I playing" to label the frame
 * in the meantime.
 *
 * That copy is *per-campaign* state, which means it obeys the same rule as
 * the narrative log and the theme: every entry into the playing phase sets
 * it, and leaving for the main menu clears it. Both halves matter. Leaving
 * it set on the way out is how a loaded campaign's slug used to bleed into
 * the *next* campaign's setup screen (the New Campaign entry point was the
 * one path into play that didn't set an identity of its own, so it inherited
 * whatever the previous session left behind).
 */
export interface CampaignIdentity {
  /** Campaign id (directory slug). "" when there is no campaign yet. */
  id: string;
  /**
   * Human-readable campaign name, when it's known before the first snapshot
   * (the setup → game handoff carries it in `session:transition`). "" when
   * unknown.
   */
  name: string;
}

/** No campaign: the main menu, and the new-campaign setup conversation. */
export const NO_CAMPAIGN: CampaignIdentity = { id: "", name: "" };

/**
 * Label for the frame title / modeline fallback.
 *
 * The server's snapshot is authoritative once it carries a name; until then
 * we fall back to the locally-known name, then to the raw id (a slug — ugly,
 * but it's the only handle we have during a resume).
 *
 * Empty strings are treated as absent (`||`, not `??`) deliberately: the
 * server broadcasts a final snapshot as part of session teardown, and that
 * one carries `campaignName: ""`. It can land after the client has already
 * reset its own state, so `??` would let the teardown snapshot blank a title
 * the fallbacks could still fill.
 */
export function campaignLabel(
  snapshotName: string | undefined,
  identity: CampaignIdentity,
): string {
  return snapshotName || identity.name || identity.id;
}
