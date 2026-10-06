# Agent and tool integration audit

**Design requirements, not shipped behavior. Audited 2026-10-05 against `d32696d1`.** This extends the [adopted co-DM architecture](README.md). The experiment remains isolated. Inventory came from executable registry definitions, provider-call sites, helper callers, setup/server paths, and `/tools/`, rather than assuming the older catalogs were current. No live calls were made for this audit; the separate startup inspection below supplies earlier live evidence.

## Inventory and governing decision

There are **21 gameplay/setup model roles including the experimental co-DM**, counting the foreground DM, combat resolver, and 18 implementations under `agents/subagents/`. Choice generation's legacy one-shot and continuing session count as one role. There are also **five content-processing model stages**, with nine specialized extraction prompts. Image rendering is a provider capability, separately accounted, not another conversational DM. `world-builder`, `setup-agent` configuration/types, `theme-list`, prompt construction, queue coordinators, and repair/validation utilities are not additional model agents.

The registry contains **37 tools**. Eight are excluded from the narrative DM, leaving **29 registry tools plus two capability-gated image tools** in the baseline DM surface. The experiment removes `scribe`, `style_scene`, and `update_portrait` from that surface. `set_theme` is an internal TUI command, **not a registered model tool**, despite lingering references in tool-name sets.

The architecture needs two principal conversations, not only two concurrent jobs. Keep bounded specialists where their isolation is useful. The engine owns their scheduling, committed effects, and recovery; the co-DM does not become a general scheduler issuing another layer of delegation calls. Move routine responsibility out of the DM prompt without granting the co-DM independent narrative or mechanical authority.

Every mutator must participate in one causal commit protocol, regardless of whether it was called by the DM, co-DM, a specialist, OOC/Dev, a UI action, or startup code. This is an engine responsibility. It must not become extra protocol bookkeeping for the storyteller models.

## Gameplay and setup agents

Paths below are relative to `packages/engine/src/agents/`. Tier labels describe current caller routing, not fixed vendors. Production co-DM routing must be explicit; the experiment's Sol 6.1 medium default is not yet a configurable role slot.

| Role and source | Current work | Decision for two lanes |
|---|---|---|
| Foreground DM — `agent-loop.ts`, `game-engine.ts` | Large-tier continuing narrative/tool loop | Keep fiction, agency, consequences, immediate mechanics, private notes, authored choices and scene images. Replace compulsory bookkeeping handoffs with observation plus optional embedded private annotations. |
| Co-DM — `experiments/co-dm-agent.ts`, `co-dm-coordinator.ts` | Experimental continuing maintenance conversation | One serialized worker, durable batched feed, frozen scene reference, optional volatile feedback. Add startup and operator events; do not wake on its own maintenance results. |
| Scribe — `subagents/scribe.ts` | Small-tier isolated `knowledge`, `remember`, `player_profile` worker; explicit and automatic handoffs | Replace its normal invocations with the co-DM. Reuse identity resolution, bounded reads, append-only profile/boundary protections, and receipts. OOC and other indirect `scribe` paths must not secretly retain a competing writer. Keep baseline mode independently selectable during rollout. |
| Setup conversation — `subagents/setup-conversation.ts` | Large-tier interactive choices, seed/fork selection, PC/portrait approval, `finalize_setup` | Keep the actual setup conversation and accepted choices. After finalization, deterministic scaffold plus one private bootstrap event starts both lanes. There is no separate live “Setup Agent” model delegating to this conversation. |
| Character promotion — `subagents/character-promotion.ts` | Small-tier sheet generation at setup and later promotions/corrections | Keep specialist. Setup can prepare a sheet alongside independent opening work. Later sheet replacement needs a fresh input revision and guarded commit, and must finish before mechanics use changed stats. Do not invent player build choices in background. |
| Combat resolver — `resolve-session.ts` | Medium-tier persistent encounter session; small-tier content-search fallback | Keep synchronous to dependent narration. Engine applies/records accepted deltas once; co-DM observes them. Refresh/invalidate resolver inputs after authoritative sheet or encounter corrections. |
| OOC — `subagents/ooc-mode.ts` | Medium-tier player conversation with registry tools and inspection extras | Keep as an operator mode, not co-DM responsibility. Share mutation protocol, emit correction events to both conversations, route bookkeeping through the existing lane, and keep discussion separate from fictional events. |
| Dev mode — `subagents/dev-mode.ts` | Medium-tier diagnostics, file/state surgery and registry tools | Keep privileged operator mode. Enter an exclusive maintenance boundary before writes; protect queue journals and live DB state. Reload/reconcile affected in-memory state and contexts before play resumes. |
| Repair state — `subagents/repair-state.ts` | Small-tier generation of missing records from transcript references, called by Dev mode | Keep explicit repair/dry-run operation. It is not automatic co-DM permission to invent missing facts. Commit at the operator boundary, preserve UIDs/disclosures, emit repair provenance. |
| Campaign search — `subagents/search-campaign.ts` | Small-tier logical knowledge and campaign-history retrieval | Keep on-demand for DM; allow co-DM to retrieve older history with the same bounded reader. Caller-aware freshness: DM waits through preceding completed observations; worker reads committed state without waiting on itself. Never search private queue/debug files as campaign facts. |
| Content search — `subagents/search-content.ts` | Small-tier faceted system-library retrieval | Keep on-demand for DM/resolver. Static rules retrieval needs no co-DM drain. Library results are reference material, not campaign events or automatic grants of abilities. |
| Theme styler — `subagents/theme-styler.ts` | Small-tier natural-language request to theme/key color; direct color/variant path needs no model | Keep helper behind co-DM `style_scene`; preserve operator styling. Guard result and canonical location update by scene/field revision. Engine-owned combat/OOC/Dev variants outrank a late exploration style. |
| Choice generator — `subagents/choice-generator.ts` | Small-tier continuing scene conversation, detached suggested player responses | Keep separate player-facing assistance. It must consume a public projection, never private annotations/notes. Fence results by exchange, PC, mode and epoch; foreground-authored choices take precedence. Stale suggestions cannot reappear after new input or a cut. |
| AI player — `subagents/ai-player.ts` | Small/medium tier selected by player config; sheet plus recent narration → action | Keep a distinct player role. Supply approved player knowledge and public narration, not the private DM conversation or co-DM reference snapshot. Refresh needed character facts without forcing a full background drain for every AI action. |
| Precis updater — `subagents/precis-updater.ts` | Small-tier dropped-exchange compression, open threads, NPC intents, player reads | Keep as context maintenance, not canonical author. Preserve authorship and source distinctions; private annotations need a private-aware compression path rather than being mixed into public narration. Co-DM context growth needs its own strategy for hundred-turn scenes. |
| Scene tracker — `subagents/scene-tracker.ts` | Small-tier deferred open-thread/NPC-intent proposals | Keep initially as a derived-context helper. Its current next-turn drain still contributes latency; do not mistake it for co-DM cost or silently remove it. Consider consolidation only after equivalent quality is demonstrated; one writer owns each derived field. |
| Scene summarizer — `subagents/scene-summarizer.ts` | Small-tier full/mini campaign-log summaries | Keep under engine scene closure, after final observation watermark. Feed public fiction separately from private facts. Summary is a derived account, not permission to promote intentions into player decisions. |
| Changelog updater — `subagents/changelog-updater.ts` | Small-tier per-entity scene-history proposals | Keep helper initially, but restrict to a scene recap or genuinely missing history. Co-DM owns event history during play; closing helper must not append the same events a second time under a different operation ID. |
| Compendium updater — `subagents/compendium-updater.ts` | Small-tier public-knowledge proposal, currently downstream of scene summary | Keep optional closing helper initially, with one publication owner/protocol shared with co-DM `disclose`. It cannot undo a newer disclosure or leak a secret alias inferred from a summary. Project approved knowledge first; do not recreate a competing identity system. |
| Narrative recap — `subagents/narrative-recap.ts` | Small-tier “Previously on…” text at session end; bullet fallback | Keep optional and player-safe. Persist result and pending-delivery state under closure; no need to hold an ordinary turn for it. |
| Discord status — `subagents/discord-status.ts` | Small-tier short public presence text from narration | Keep optional background helper outside both principal conversations. Public text only; discard stale session results. Include in accounting without making it a world-state barrier. |

## Content-processing agents

These run in `packages/engine/src/content/`, outside gameplay. Keep their architecture and library format separate; moving campaign memory to SQLite or adding a co-DM does not imply converting sourcebooks, seeds, or DM seeds.

| Stage | Source | Disposition |
|---|---|---|
| Page classifier | `classifier.ts`, dispatched by `process.ts` through Anthropic batches | Keep ingestion-only. Provider/model compatibility is a separate pipeline concern, not a new campaign lane. |
| Section extractors | `extractors.ts` | Keep all nine prompt variants: monsters, spells, rules, chargen, equipment, tables, lore, locations, generic. None receives campaign-private feed. |
| Merge comparison | `merge.ts` | Keep duplicate/version comparison in content-library ingestion, separate from campaign UID convergence. |
| Cheat-sheet generation | `indexer.ts` | Keep model-produced quick reference; the TOC/facets are deterministic code, not extra agents. |
| Rule-card generation | `rule-card-gen.ts` | Keep system reference preparation. Version the loaded reference at handoff; publishing new library material does not silently mutate active campaign facts. |

The older catalog's “legacy resolution” implementation is not present in the current model-call inventory. Its separate setup-orchestrator description is also obsolete. “Planned PDF extraction/organization/cheat sheet” overlaps the implemented ingestion stages above; planned crunchy character creation and broader rule distillation should not be counted as additional running agents. Catalog corrections should follow actual implementations, not perpetuate historical role names.

## Complete registered-tool disposition

Exact registry names are listed once in the first column below. **DM** means baseline narrative availability; **operator** means currently excluded from the narrative DM. Shared capabilities do not imply equal authority to decide outcomes.

| Tool | Current surface | Planned owner and consistency rule |
|---|---|---|
| `roll_dice` | DM | DM/resolver. Resolve before narration; persist accepted outcome/provenance so a delivery retry does not reroll an already accepted action. Oracle rolls remain private. |
| `deck` | DM | DM for create/shuffle/draw/return/peek/state. Keep ordered engine deck state authoritative; co-DM records outcomes, never independently draws or reconstructs deck order. |
| `map` | DM | DM for create/view/terrain/annotations/regions. Keep spatial state authoritative; background recordkeeping may describe accepted edits, not invent tactical geography. |
| `map_entity` | DM | DM for placement/movement/removal/import and nearest lookup. Return committed movement before dependent narration; don't let metadata location overwrite authoritative movement. |
| `map_query` | DM | DM/resolver-facing spatial read. Read current committed map revision, not frozen tree; no general bookkeeping drain. |
| `alarm` | DM | DM schedules/clears/checks commitments. Co-DM observes; it does not infer deadlines or fire consequences. Preserve private alarm text. |
| `time` | DM | DM advances calendar/round clock; engine emits fired alarms once. Include scene-transition clock advances in the same event path. |
| `start_combat` | DM | DM decides; engine initiative/clock/resolver initialization stays ordered. Co-DM records start and routine presentation. |
| `end_combat` | DM | DM decides; engine tears down resolver and clears combat state. Late background combat display cannot re-enable it. |
| `advance_turn` | DM | DM/engine initiative; never a co-DM bookkeeping action. Publish active actor after commit. |
| `modify_initiative` | DM | DM/engine add/remove/move/delay, with authoritative order and feed event. |
| `update_modeline` | DM | Shared: DM expressive intent, co-DM routine updates. Guard per character and causal revision; preserve custom meaning. |
| `style_scene` | DM | Move routine calls to co-DM; retain OOC/Dev operator access. Helper optional for descriptions, direct path for color/variant. Guard UI and location persistence, not just final broadcast. |
| `set_display_resources` | DM | Shared: retain DM custom keys; co-DM routine key selection. Initialize keys and values coherently, including startup and PC swap. |
| `set_resource_values` | DM | Shared capability, distinct authority: DM/resolver decides mechanical changes; co-DM mirrors established values and updates narrative displays. Underlying state writes, not tool names, advance per-field revisions. |
| `present_choices` | DM | Keep DM-authored dilemmas. Co-DM cannot offer narrative choices; suggestion generator remains separate. No empty calls that suppress useful suggestions. |
| `show_character_sheet` | operator | Keep operator/UI read of approved current sheet. Refresh or expose pending relevant edits; no private co-DM text in modal. |
| `enter_ooc` | DM | Keep foreground mode transition. Co-DM must know operator corrections as such; no second narrator answering the player. |
| `switch_player` | DM | Keep DM/engine turn ownership. Stamp pending UI work with character identity so a late callback cannot affect the newly active PC. |
| `swap_pc` | operator | Keep operator-authorized roster handoff. One coordinated operation covers roster, sheet, party, resources, portrait and context refresh; drain/fence conflicting work. |
| `howto_swap_pc` | operator | Keep read-only playbook; revise for canonical handles and coordinated handoff. It must not instruct a fresh independent scribe lane. |
| `list_dm_personalities` | operator | Keep read-only catalog access; no background dependency. |
| `swap_dm_personality` | operator | Keep operator choice and foreground fictional voice handoff. Explicit configuration change may rebuild prompt identity midscene; ordinary metadata still must not. Update co-DM reference deliberately. |
| `howto_swap_dm_personality` | operator | Keep playbook; add two-conversation refresh semantics, no co-DM authority to choose a persona. |
| `howto_campaign_state` | operator | Keep state-map playbook; document queue/journal ownership, private feed and supported correction paths. |
| `scene_transition` | DM | DM chooses cut; engine closes exchange, drains through watermark, runs closing helpers, advances clock, checkpoints, rebuilds both contexts. Co-DM cannot request cuts to shorten its context. |
| `session_end` | DM | DM/player initiates; same closure plus recaps and durable queue state. Server/menu shutdown must honor equivalent persistence guarantees. |
| `rollback` | operator | Engine-exclusive epoch invalidation before restore. OOC, Dev, slash command and picker must use the same entry point, including callbacks and image jobs. |
| `search_campaign` | DM | Keep DM; add bounded co-DM history retrieval. Caller-scoped freshness, never worker-waits-for-itself. |
| `search_content` | DM | Keep DM/resolver rules/library lookup; no campaign maintenance barrier. |
| `scribe` | DM | Remove from two-lane DM prompt/tool surface. Route remaining operator compatibility handoffs into the single co-DM lane; no simultaneous legacy scribe. |
| `dm_notes` | DM | Foreground-owned private scratchpad. Commit writes and feed their actual contents; co-DM observes but does not rewrite planning through `remember`. Current note changes arrive in volatile context without replacing the scene prefix. |
| `resolve_turn` | DM | Keep dependent combat specialist. Distinguish proposed deltas from engine-applied HP/resource changes and not-yet-applied conditions/positions. Co-DM cannot treat every returned delta as committed state. |
| `promote_character` | DM | Keep explicit DM/operator initiation and small-tier specialist. Route completion through the guarded mutation path; canonical sheet replacement must not race co-DM body edits. |
| `knowledge` | DM | Shared read: frozen outline for orientation, explicit committed reads for details. Foreground dependent read waits a captured prior watermark; co-DM reads directly. |
| `remember` | DM | Co-DM primary writer; keep foreground explicit corrections/identity binds. Enforce reserved field ownership and revision preconditions at commit, preserve text and receipts, return canonical UIDs/impact candidates. Impact is not an automatic consequence. |
| `manage_objectives` | DM | Retain DM decisions; give co-DM routine recording only of explicitly established/accepted objectives and outcomes. Keep `state.objectives` and knowledge-tree references synchronized through one command; an ignored hook is not a quest acceptance. |

### Dynamic image tools and internal commands

| Surface | Decision |
|---|---|
| `generate_image` — appended by `agent-loop.ts` when enabled | Foreground DM retains prompt composition and scene-image obligations. Ordinary scene image remains asynchronous; explicit player image request retains its synchronous behavior. Feed request, completion/failure and asset identity separately. Never interpret an image depiction as new canonical fiction. |
| `update_portrait` — appended when supported/enabled | Co-DM gets lasting appearance maintenance, preserving identity, references and silent updates. Capture UID, appearance revision and epoch; late render cannot overwrite a newer approved portrait or a rolled-back appearance. Paid requests need recoverable status, not automatic duplicate submission. |
| `set_theme`, `resource_refresh`, `character_sheet_changed`, image/UI broadcasts | Engine commands/events, not additional LLM tools. All producers must honor the same revisions and session identity. Theme changes from combat/modes and authoritative startup/reconnect snapshots must not be overwritten by a late worker. |

Image-provider capability/routing must be checked against the actual image executor, independently of the co-DM text-model connection. Switching the co-DM vendor must not silently remove or misroute portraits.

## Nested and operator-only tools

These do not enlarge the baseline DM surface, but their effects/read permissions still matter.

| Tool set | Integration |
|---|---|
| Setup: `finalize_setup`, `present_choices`, `load_world`, `roll_dice`, capability-gated `generate_image`, `set_portrait` | Keep setup-local contracts. `load_world` selection and approved portrait become provenance in bootstrap, not a transcript the co-DM must reverse-engineer. Finalize exactly once; don't repeat accepted art or sheet creation on reload. |
| Resolver: `roll_dice`, `read_character_sheet`, `read_stat_block`, `query_rules`, `search_content` | Keep specialist capability bounds. Sheet read needs committed required mechanics; library reads do not wait on campaign bookkeeping. |
| Campaign search: `grep_campaign`, `read_campaign_file`, logical knowledge access | Preserve `campaign/` and `rules/` allowlist and explicit UID reading. `state/`, `.debug/`, private queue and provider context files must not become searchable story history. |
| Content search: `list_categories`, `search_facets`, `read_entity` | Keep library-only; no canonical campaign writes. |
| Scribe/co-DM: `knowledge`, `remember`, `player_profile` | Keep machine-scope player profiles and append-only boundaries distinct from rollbackable campaign state. Deduplicate retries; don't “undo” a newly declared player boundary on campaign rollback. |
| OOC extras: `find_references`, `validate_campaign`, `get_commit_log`; registry minus `enter_ooc` | Keep inspection capability. OOC inherits the registry, not dynamically appended DM image tools. Its mutation results must join the feed even though it bypasses the narrative DM loop. |
| Dev extras: `read_file`, `write_file`, `list_dir`, `get_game_state`, `set_game_state`, `repair_state`, `get_scene_state`, `validate_campaign`, `search_files`, `delete_file`, `get_commit_log`, `find_references`, `rename_entity`, `merge_entities`, `resolve_dead_links`; all registry definitions | Keep explicit diagnostics, dry runs and surgery. Existing raw-memory write ban is insufficient for co-DM journals under `state/`: guard those separately. Rename/merge must preserve canonical redirects; emit correction events. A registry definition with an async stub is not evidence Dev has a working dispatcher for that tool. |

The requested co-DM surface is deliberately small: knowledge read/write, player-profile append, campaign-history retrieval, theme/portrait maintenance, the three shared display tools, and established-objective recording. No dice, decks, time advancement, initiative, narrative choice modals, scene cuts, private note authorship, or scene images. The last two additions, history retrieval and objective recording, are design work, not claims about the prototype allowlist.

## Warts and resulting design requirements

### 1. A tool result is not always a committed effect

Several registry handlers return a TUI/deferred command. `GameEngine` later performs the sheet, notes, scribe or lifecycle work; helper failures can occur after the original tool result. Capture accepted intent and actual completion/failure separately. Put receipts/revisions at the canonical mutation boundary, with a shared operation ID across tool, helper, store and UI effects. Do not let the co-DM canonize “promotion succeeded” merely because a command was queued.

`applyResolutionDeltas` currently mutates `resourceValues` directly, outside the prototype's presentation-tool revision increments. It applies HP/resource deltas, but conditions and positions are currently left for narration rather than applied to corresponding state. This is a concrete integration gap: guard all resource writers and expose actual application status. Choosing the first display key as an HP fallback is also unsafe once expressive keys and mechanical resources coexist; mechanics need an explicit resource key/binding.

`remember` can also edit records used by mechanics, notes and presentation. Tool allowlists alone cannot express field ownership. Protect engine/foreground-owned targets at commit without imposing fixed categories on the rest of the arbitrary tree. A correction from another writer becomes new evidence, not a license for an old worker to restore its previous interpretation.

The prototype snapshots presentation revisions when its worker starts. Production guards must also cover foreground changes made after an observation but **before** its queued batch starts; “unchanged during my API call” is weaker than “still valid for the events I consumed.” Carry causal revisions/watermarks from observed state and rebase against newer committed facts.

### 2. Normal DM dispatch is not the only entry point

OOC shares much of engine dispatch, but its conversation and outcomes do not pass through the prototype's DM-only feed assembly. Dev has a separate handler and fallback registry dispatch. Promotion currently waits on `deferred`, not the experimental co-DM. All need integration.

More seriously, slash `/rollback` calls `performRollback` directly in `server/command-handler.ts`, whereas DM/OOC deferred rollback uses the engine's fenced path; Dev also calls restore directly. `/save` directly requests a Git checkpoint. Consolidate these with menu/picker/retry and server teardown under engine lifecycle operations. Restoring files and only then ending the session is too late to fence an in-flight writer. Snapshotting unrelated files while a worker commits does not create a consistent save.

Use a controlled pause/drain for operator surgery and dependent full-sheet replacement; keep ordinary storytelling free of a global drain. Capture a finite observation watermark for reads so new arrivals cannot turn a lookup into an unbounded wait. The co-DM's own reads and closing helpers must not recursively await their own lane.

### 3. Closing helpers currently overlap the proposed writer

`SceneManager.stepSubagentUpdates` runs summarization and changelog generation in parallel; compendium generation depends on the summary. It journals proposals before applying receipt-backed history/publication batches. Preserve that recovery work and the existing parallelism.

After adoption, event history belongs to co-DM; the changelog helper may produce one distinct scene recap, not repeat event entries. Public disclosure belongs to a common canonical publication path. Closing compendium is a bounded proposal against the drained public snapshot; it may consolidate or add grounded approved information but cannot replace newer public facts or rename an unrevealed person from private knowledge. Do not solve overlap by making co-DM call all three helpers in sequence.

The pilot already exposed agency/disclosure errors in shared summaries/publication. Queue correctness does not establish semantic correctness. Score those outputs separately and preserve public/private provenance throughout summary, compendium and recap generation.

### 4. Two queues do not eliminate other asynchronous consumers

Suggested choices, image/portrait renders, scene tracking, Discord presence, and context compression still exist. Required canonical writes join lifecycle barriers; optional projections can be invalidated/dropped by epoch rather than holding every transition. Each needs declared ownership and a completion/publication fence.

In particular, `aiTurn` reads the DM conversation for recent assistant text, while co-DM annotations remain private in that conversation. Its current string-only extraction also misses block-array narration. Supply an explicit public narration projection rather than either leaking private frames or silently losing context. Choice generation also needs a public sheet/context projection and a completion guard. These are source-level integration risks, not newly observed live leaks.

Scene tracker and precis are derived hints, not unquestionable world facts. Keep them initially, with source labels; measure their remaining waits. Co-DM continuity across very long scenes needs bounded history/compaction with canonical UID preservation, without forcing narrative cuts or rebuilding the DM's scene prefix.

### 5. Objectives, location and mechanical displays have multiple representations

The objective tool writes `state.objectives`; campaign knowledge can independently describe objectives. Spatial tools write maps; knowledge can independently describe location. Resource values serve display and mechanics. Specify which representation is authoritative for each operation, and project committed facts into the other representation using stable identity/provenance. Do not let the co-DM create a second quest list or undo a movement because an older scene description named the previous room.

### 6. Configuration, contracts and observability need real production plumbing

Give co-DM an explicit role/provider/model/effort configuration resolved through normal known-model capability logic. Keep small-tier helpers independently routable; the baseline Scribe/Small validation target remains Luna. Hardcoded Sol defaults and usage reported only as “large” are insufficient for heterogeneous connections or cost tuning.

All advertised tools, including dynamically added portrait tools and operator extras, need executable input contracts and consequence classes. Advertise only tools with a working dispatcher in that role. Prompt migration includes tool descriptions, OOC playbooks, startup synthetic input, helper prompts and seed instructions—not only regex replacement in the main resolved DM prompt. Seeds remain untouched as formats; the enclosing runtime contract must clearly identify embedded legacy directions and the current tool interface.

Record exchange/event IDs, parent role, scene/epoch, attempted/committed/rejected status, provider model/effort, required watermark, queue lag and render status. Private feed/context/journals stay private; player logs, AI players, Discord and exports consume approved projections. Count helper usage under its invoking role without double billing or attributing overlapping wall time twice.

## Campaign-start integration

The preceding live baseline inspection used The Long Patience, Sol 6.1 setup/high and DM/medium, Luna helpers, and enabled images. Evidence is in the local ignored `.batch-runs/co-dm-startup-20261005/inspection.md`; raw campaign/private data is intentionally not copied into this design document.

Final confirmation to opening completion was **79.114 s**, including **32.267 s** to game-session start and **46.823 s** for the opening turn. Initial sheet generation took **8.291 s** within setup/handoff; detached opening scribe took **22.647 s** afterward. Opening image rendering took **90.806 s** and completed **165.309 s** after confirmation, asynchronously. These are one baseline run, not a co-DM startup benchmark, first-token timing, or reproduction of the reported five-minute case.

The handoff contained 16 entity records/62 total nodes, approved portrait and complete PC sheet. Seed bodies and visibility survived; opening location retained its UID on rename. A concrete omission was that resource values were set without display keys, leaving the bar empty. A later return-to-menu also hit both deferred-work teardown timeouts while a scribe was still running: a clean SQLite integrity check afterward does not prove every intended write survived.

The proposed startup sequence is:

1. **Finalize accepted setup once.** Retain player approvals, selected seed/fork provenance, boundaries and portrait reference. Setup provider disposal precedes game-provider startup where their subprocess/auth lifecycle requires it; do not parallelize across that boundary blindly.
2. **Create and commit the minimal scaffold.** Config, canonical PC/party/location handles, selected seed data and required assets are deterministic. Establish a durable startup ID/state; the current best-effort Git commit alone is not a transaction gate.
3. **Deliver one private bootstrap envelope to both lanes.** Include accepted setup, hidden seed material with provenance, private handoff letter, opening directive, store revision/handles, portrait reference, and sheet/UI task status. The current co-DM frozen-prefix copy misses the separately injected handoff letter, and it only wakes after a completed DM exchange. Bootstrap is therefore required for actual parallel startup.
4. **Run distinct responsibilities.** DM authors the opening and image prompt. Co-DM initializes routine displays and records only established canonical facts. Initial sheet specialist can overlap independent narrative work; a roll using those stats must await its accepted result. The co-DM cannot independently select or rename the actual opening location from an unrealized plan.
5. **Publish coherent progress and resume state.** Distinguish scaffold ready, opening in progress, opening delivered, required mechanics ready, and pending background work. Preserve newer background UI updates when the server emits its authoritative snapshot. Record bootstrap once even if no public player input exists yet; do not classify `skipTranscript` opening directives as a player's action, as the experimental feed currently does.

Allow player input once the opening and necessary mechanics are ready. Initial theme, portrait maintenance and routine records may continue under normal lag rules. Crash/reload must recover the existing startup job rather than generate a second opening or repeat paid art. Content boundaries are available before either lane narrates or records anything.

## Developer tools and surrounding surface

| Surface | Required integration |
|---|---|
| `tools/campaign-explorer` | Already a privileged read-only SQLite logical-tree/state/context viewer. Keep raw SQLite sidecars blocked and private data explicitly privileged. Add co-DM queue/cursor/watermark/epoch and pending-job visibility, context selection and role-aware spans; verify overlapping work after foreground readiness is visible. Do not render private journals as player transcripts. Its contract tests cover state-file and context-envelope changes. |
| `tools/theme-editor` | Read-only asset preview using the real client renderer. No agent/queue change needed. Preserve theme/variant command compatibility and preview assets; runtime stale-result fencing belongs in engine/client contracts, not this editor. |
| Server/session, shared protocol, clients | Every mutation route—including player cycling, OOC/Dev, PC/personality changes, resource/UI callbacks and manual save/restore—must pass identity/revision/lifecycle rules. Distinguish player readiness from maintenance catch-up. Reconnect snapshots must reflect current revisions. |
| Harness, goldens, debug/tape/export | Add co-DM event/barrier predicates and role buckets, startup evidence, private-frame filtering and crash schedules. Existing offline goldens can mock away helpers; they cannot substitute for semantic review. Dumps are privileged, public replay/export is filtered. |

## Integration order and release evidence

1. Implement one engine mutation/lifecycle protocol and causal feed across DM, operator routes and specialists; finite read barriers; canonical guards; durable recovery and paid-job status.
2. Add startup bootstrap, coherent UI initialization and resume states. Exercise rich seeded and custom setup before broadening normal-launch exposure.
3. Wire the small co-DM capability set, role configuration and complete prompt/playbook migration. Retain specialist implementations initially; assign one writer for event history and public disclosure.
4. Integrate projections, long-scene context handling, tools/explorer and tests. Re-run quality play across a scene boundary and at least three following turns, including save/reload and operator corrections.

See [test-plan.md](test-plan.md#agent-and-tool-integration-gates) for the added gates. Architecture adoption is settled; these findings define correctness/integration work, not a reason to reopen cost-based adoption or turn the co-DM into an engineer.
