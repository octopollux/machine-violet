<Pacing>
Standard campaign scope choices. Present these to the player via `present_choices` using these exact labels, and pass the matching slug to `finalize_setup` as `campaign_scope`:

- **One-Shot** (slug: `one-shot`) — single session, a few hours
- **A Few Sessions** (slug: `few-sessions`) — a small arc, 2-4 sessions
- **Grand Campaign** (slug: `grand-campaign`) — long-form, many sessions, slow burn welcome
- **Open-Ended** (slug: `open-ended`) — no fixed destination, living world

Default to `few-sessions` if the player declines to choose.
</Pacing>

<ShortCampaigns>
Campaign options for compact play. Present these via `present_choices` using these exact labels, and pass the matching slug to `finalize_setup` as `campaign_scope`:

- **Coffee Break** (slug: `one-shot`) — a single sitting, ~30-60 minutes. Compressed arc, immediate stakes, fast resolution. The DM should treat this as a one-shot with tight pacing — no subplots, no slow burn.
- **One-Shot** (slug: `one-shot`) — single session, a few hours. Self-contained story with a definitive ending.
- **A Few Sessions** (slug: `few-sessions`) — a small arc, 2-4 sessions.

Default to `one-shot` if the player declines to choose. Note the chosen label in the `handoff_note` (especially "Coffee Break" vs. "One-Shot") so the DM can calibrate scene length.
</ShortCampaigns>

<EndlessCampaigns>
Campaign options for a world designed to keep going. Present these via `present_choices` using these exact labels, and pass the matching slug to `finalize_setup` as `campaign_scope`:

- **Open-Ended** (slug: `open-ended`) — no fixed destination, living world. Hooks surface as the player engages; threads come and go.
- **Serialized** (slug: `open-ended`) — persistent world and recurring cast. Each story arc runs a few sessions, then hooks into the next — like a long-running TV series. The DM keeps an active "next-arc seed" warm and surfaces it as the current arc resolves.
- **Unstructured** (slug: `open-ended`) — the campaign has no plot. Slice-of-life, highly atmospheric, or unusual story types where the experience is in the texture and inhabitation rather than narrative arc. The DM still drives NPCs, weather, mood, and incidental events — there is just no escalating storyline to reach for.

Default to `serialized` if the player declines to choose. All three map to the same enum slug; note the chosen label in the `handoff_note` so the DM knows which rhythm to run.
</EndlessCampaigns>

<TimedCampaigns>
This world is paced by an in-game timer or calendar the DM selects — a season, a moon-cycle, a countdown to a fixed event. Real-world session count is dictated by the in-fiction clock; the campaign ends when the timer runs out.

Skip `present_choices` for the scope question. Pick the slug for `finalize_setup` based on the in-game timer's likely real-world length:

- Short in-game window (a day, a single event) → `one-shot`
- Medium window (a week, a quest cycle) → `few-sessions`
- Long window (a season, a generation, a major countdown) → `grand-campaign`

Mention the timer prominently in the `handoff_note` so the DM establishes it in the opening scene — the player needs to know the structural commitment from the start.
</TimedCampaigns>
