# Continuing co-DM

The foreground DM owns fiction, player agency, immediate mechanics, private notes,
and every scene-image prompt. A continuing co-DM observes completed exchanges and
committed tool outcomes, maintaining campaign knowledge and routine presentation.
Private inline `<co_dm>...</co_dm>` annotations carry hidden intent without an
extra tool continuation. A proposed opening, suggested choice or NPC claim is
not an established player action.

The Connections screen's Model Assignments includes **Continuing co-DM**. Its
picker spans available models on all connected providers, independently of Small
helpers, and offers the model's discovered supported effort levels. Auto follows
DM narration; the co-DM's agent default is medium effort where supported.
`connections.json` persists an optional `coDmAssignment` with `connectionId`,
`modelId`, and optional `effort`; absent assignment follows Large. Null effort is
an explicit preference to disable reasoning where the provider permits it.
`GET/PUT /manage/tiers` exposes the same assignment. Known-model aliases resolve
to the discovered backend model before co-DM capability selection. A co-DM-only
connection shares the session provider cache and disposal lifecycle.

DM and co-DM tools share public activity glyphs. Activity carries only tool name,
role and engine-assigned call identity. Completed background tools do not change
foreground readiness or clear glyphs. The normal DM turn-end boundary clears the
accumulated glyphs; later background calls may appear during player input.

Campaign Explorer is privileged and read-only. Co-DM queue/context, cursor,
epoch, completion and operation journals appear under **Co-DM (privileged)**,
separate from player transcripts. Context dumps and role-named trace spans remain
selectable alongside ordinary DM and specialist work. Raw SQLite sidecars remain
blocked. Theme Editor continues to use the existing theme and variant renderer.

Scene closure retains its durable transition journal, campaign log, public scene
summary, and session recap. Public helpers receive a source projection containing
whole player/DM entries with exact speaker labels and approved identity names;
multiline tool results and private annotations never enter that projection.
Written transcripts use the same projection. Tool context remains in privileged
conversation/debug records. The private precis and scene tracker preserve plans,
claims and completed outcomes as distinct categories.

When the co-DM owns knowledge maintenance, closing changelog and compendium
generators are skipped. This gives entity history and approved disclosure one
writer, preserving newer public facts and avoiding duplicate event history. The
scene summary remains a separate narrative log entry. Baseline mode retains its
parallel legacy generators and receipt-backed journal; its public helpers use
the same approved source projection. A pre-projection pending summary recovered
under co-DM is regenerated from public sources before publication.

## Acceptance coverage

The following maps acceptance themes to deterministic regressions. Test doubles
exercise production control flow and persistence; they do not establish live
model judgment, latency, cost, or reliability. Live validation is reported
separately after the run, with its actual provider/model configuration.

The [production validation report](experiments/co-dm/production-validation-2026-10-05.md)
records the live campaign audit, measured boundaries, configured-cost estimate,
and remaining coverage limits.

| Acceptance theme | Concrete regression evidence | Limits |
| --- | --- | --- |
| Independent provider/model/effort | [tier-resolver.test.ts](../packages/engine/src/config/tier-resolver.test.ts), [connections.test.ts](../packages/engine/src/config/connections.test.ts), [management.test.ts](../packages/engine/src/server/routes/management.test.ts): assignment persistence, backend aliases, unsupported efforts and clearing assignment | Capability discovery is fixture driven; actual provider compatibility needs live calls. |
| Private frames and exact public speakers | [co-dm-protocol.test.ts](../packages/engine/src/agents/co-dm-protocol.test.ts): UTF-8/UTF-16 splits and incomplete frames; [public-transcript.test.ts](../packages/engine/src/agents/public-transcript.test.ts): multiline private tool payloads, forged headers and approved identities | Projection removes private sources; it cannot prove a model will never infer an undisclosed fact. |
| Continuing ordered worker, retry and reload | [co-dm-coordinator.test.ts](../packages/engine/src/agents/co-dm-coordinator.test.ts): pending cursor retained on failure, explicit retry, durable enqueue, continuity across scene cuts; [co-dm-integration.test.ts](../packages/engine/src/agents/co-dm-integration.test.ts): restored durable state and accepted-response replay | Injected failures cover named boundaries, not every possible OS/process interruption. |
| Causal guards and operator admission | [co-dm-integration.test.ts](../packages/engine/src/agents/co-dm-integration.test.ts): stale themes/objectives, independent resource fields and abandoned effects; [operator-admission.test.ts](../packages/engine/src/server/operator-admission.test.ts): real engine admission without self-wait | Arbitrary future mutation tools must participate in the same guards. |
| Startup ownership and opening recovery | [startup.test.ts](../packages/engine/src/agents/startup.test.ts): accepted handoff identity and startup journal failures; [startup-recovery.test.ts](../packages/engine/src/server/startup-recovery.test.ts): interrupted final write does not regenerate accepted opening | Mocked setup output does not establish generated-sheet quality or small-model instruction following. |
| Single knowledge writer and public closing helpers | [scene-manager.test.ts](../packages/engine/src/agents/scene-manager.test.ts): co-DM history/disclosure ownership and legacy private proposal recovery; [co-dm-ownership-regression.test.ts](../packages/engine/src/knowledge/co-dm-ownership-regression.test.ts): reserved notes ancestor mutation and arbitrary taxonomy | Summaries still require model semantic judgment; prompt constraints alone are not a correctness proof. |
| Shared visible tool activity | [event-handler.test.ts](../packages/client-ink/src/event-handler.test.ts): real co-DM tool names, overlapping calls and late calls; [activity.test.ts](../packages/client-ink/src/tui/activity.test.ts): surface glyph coverage; [components.test.tsx](../packages/client-ink/src/tui/components/components.test.tsx): glyphs while waiting for input | Renderer tests establish state/display behavior, not a live terminal visual inspection. |
| Privileged inspection | [co-dm-visibility.test.ts](../tools/campaign-explorer/tests/co-dm-visibility.test.ts): queue, startup, portrait/image jobs and provider journals classified separately from player transcripts | Explorer is an operator surface; these files can contain private accepted intent and results. |

Provider-round journals preserve accepted foreground and co-DM intent, including
in-band tool results. Ordered receipts freeze accepted provider responses and
tool intent. Canonical SQL, objective state and deck state carry their own
mutation receipts; distinct foreground stochastic calls retain distinct call
identities. A successful ordinary paid render result is journaled before asset
commit. An uncertain paid image or portrait submission is not automatically
resubmitted: the operator must reconcile its outcome. These boundaries do not
provide universal exactly-once behavior for external providers.

Canonical revision checks conservatively reject maintenance computed from stale
knowledge. At the long-scene context cap, invalid continuity invokes explicit
compaction; invalid compaction fails closed and retains the pending backlog
rather than silently discarding it.

Replay acceptance must additionally demonstrate that an
accepted stochastic or paid effect is not executed twice after recovery; a
generic deck/dice unit test or zero-live-call tape replay alone does not establish
that property. Scene-image jobs, portrait jobs and provider journals are shown in
Explorer's privileged category because their recovery payloads are not public
campaign facts.
