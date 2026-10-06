# Continuing co-DM lane

**ARCHITECTURE ADOPTED; IMPLEMENTATION STILL ISOLATED — 2026-10-05.** Following the latency results, the project owner selected the continuing co-DM as the direction for MV. Cost parity is an optimization objective, not an adoption gate; it has not yet been demonstrated. Correctness and production integration remain release gates. The current implementation uses an explicit `GameEngine.coDmExperiment` constructor option for isolated campaign copies; normal launches retain the existing scribe behavior until that work is complete. The [test plan](test-plan.md) distinguishes intended evaluation from measured coverage, and the [pilot report](pilot-2026-10-05.md) records evidence and limitations.

## Implemented experiment boundary

The foreground prompt is migrated after normal include/conditional/seed resolution. It retains fiction, player agency, mechanics, and scene-image guidance; the continuing co-DM receives the inherited factual-maintenance rules and a frozen, explicitly non-authoritative foreground reference snapshot. Both prototype agents use Sol 6.1 at medium effort. The baseline retains Sol 6.1 medium plus its normal Luna scribe.

Exact, case-sensitive `<co_dm>…</co_dm>` frames travel inside ordinary DM prose. The incremental parser withholds private bytes, preserves public/annotation order across arbitrary streaming chunks, and quarantines malformed or unfinished frames. Public narration, display logs, and transcripts are filtered. **The DM's own conversation file remains private and retains its annotations**, just as it retains private tool context; it is not a public export. The observation queue and completion/operation journals are also private.

Only complete exchanges wake the serialized co-DM. A busy worker collects subsequent exchanges into its next batch; its own writes do not wake another batch. `knowledge` and `search_campaign` wait for previously completed observations. Ordinary narration does not impose that drain. Scene transitions and session end drain maintenance; rollback fences old work and waits for abandoned effects before restoring files. UID notices use the canonical store's existing durable notice path. Optional freeform feedback enters volatile DM context and is acknowledged only after the successful consuming DM exchange is durable.

The prototype persists a continuing context, pending exchanges, cursor, feedback mailbox, and accepted exchange IDs. A completion journal recovers a completed public exchange and its private observation after an interrupted foreground save or queue enqueue. Background resource and UI changes are persisted before cursor acknowledgment. Foreground presentation revisions protect newer values, with independent resource fields filtered separately.

This is **not general exactly-once recovery**. Tests cover selected crash points and stable receipt retries, but regenerated provider calls or changed batch membership can change positional operation identity. Append-only player-profile writes and paid render requests also need stronger recovery semantics before production. Completion journaling is not an atomic transaction over every gameplay tool effect. Real filesystem runs use atomic replacement; injected FileIO implementations without that capability cannot claim the same durability. These limitations remain production blockers even if a normal-play pilot is successful.

Theme revision guards reject stale styling and recheck after location lookup before dispatching a canonical update. An already-dispatched location update still lacks a transactional revision precondition inside the store, so a conflict during that update can commit an older location value. The prototype does not claim cancellation at that boundary; production hardening needs a storage-level precondition or serialized write ownership.

## Purpose and boundary

The [agent and tool integration audit](agent-tool-audit.md) inventories all 21 gameplay/setup model roles, five content-processing stages, 37 registered tools, dynamic image tools, operator paths and developer tools. It also incorporates the live startup inspection. Its ownership and release requirements extend this plan; proposed changes there are not yet implemented by the isolated prototype.

Keep the foreground DM immersed in running the world while a continuing background co-DM observes completed exchanges and maintains campaign memory and routine presentation. The co-DM replaces/evolves the existing small-context scribe lane; it does not add an obligatory third storyteller or another mandatory scribe pass. Other existing helpers remain independently scoped and must be included in any accounting.

Today the [scribe prompt](../../../packages/engine/src/prompts/scribe.md) receives explicit narrative handoffs and bounded current records in a fresh invocation ([implementation](../../../packages/engine/src/agents/subagents/scribe.ts)). The [DM directives](../../../packages/engine/src/prompts/dm-directives.md) consequently require the DM to spell out updates and identity handles. The proposed co-DM instead has a persistent scene conversation and an ordered observation feed. The foreground DM knows it observes both the transcript and authoritative state events, including private notes, and communicates only what observation cannot supply.

## Agreed division of responsibility

| Responsibility | Foreground DM | Continuing co-DM |
|---|---|---|
| World, NPC behavior, narrative outcomes | Authoritative; commits what actually happens | Records established facts; cannot invent outcomes |
| Player character authorship | Preserves the player's words, actions, thoughts, feelings, and interpretations | Never fills gaps by deciding for the player |
| Mechanics needed for narration | Keeps dice, resolution, and authoritative resource tools; awaits dependent results | Observes results and maintains their records/display |
| Campaign memory | Supplies hidden intent, identity binds, corrections, and staging requests when needed; retains explicit correction ability | Maintains typed current facts, history, identities, custody, and player-safe disclosures |
| Private `dm_notes` | Owns the scratchpad and narrative planning | Can observe authoritative note events; cannot assume unexpressed private reasoning |
| Scene cuts | Decides cuts for narrative reasons | Completes maintenance through the closing exchange watermark |
| Scene images | Keeps **all** generation and prompt composition | Does not compose or request scene images |
| Portraits and theme | Establishes fictional changes and relevant artistic intent | Updates lasting PC portrait changes and applies theme changes |
| Modeline and resource display | Retains expressive/artistic use | Handles routine maintenance |

The image boundary is deliberate: the DM's creative inner intent cannot reliably transfer through a transcript or a short handoff. All existing scene-image discipline stays with the DM: cadence, once-per-subject introductions, illustrated-subject notes, art direction, composition/renderer constraints, reference-character selection and expressions, character frequency, fire-and-forget narration, and the immediate requested-image exception. Portrait updates transfer with their existing lasting-change, silent-update, and likeness-preservation guidance.

The engine must retain authoritative mechanical state separately from presentation, even when a displayed field uses a playful name or value. A joke or dramatic label cannot replace the resource state used to resolve an action.

Both agents may use modeline/resource presentation. Routine updates must preserve custom keys and their intended meaning: “swear jar funds remaining” and “HOLDING BREATH” are legitimate artistic choices. The co-DM must not normalize these into generic mechanics or replace a newer DM choice with stale queued work. Protection is field-specific and causal, not a permanent foreground lock: later established events can legitimately update or retire “HOLDING BREATH” and other custom keys while retaining their meaning. Mechanical resource resolution remains authoritative **before** dependent narration; a display mirror may lag. The co-DM cannot retroactively resolve an action or spend currency. Engine-owned mechanical writes/results remain authoritative, and stale background writes to the same resource must be rejected rather than overwrite them. These are separate consistency requirements, even if existing tools expose both concerns together.

## Observation and communication

The engine supplies a typed, durable, ordered feed containing player inputs, completed DM narration, successful **and failed** tool outcomes, authoritative state changes (including private DM notes), explicit annotations, and lifecycle events. Source and ordering must distinguish an attempted action from a committed result, a rumor from a fact, and a character's claim from authoritative narration. Neither transcript access nor a personality's unreliable narration grants access to private reasoning or makes a false claim canonical truth.

The DM embeds optional private communication in its main assistant response. This communication path and the role split are agreed; a `<co_dm>` block is only a tentative encoding, and the precise framing/parser design is a prototype choice. This is **not a communication tool call**, and receiving communication does not force a result-driven DM continuation. The engine separates the private annotation before any player output, including streamed output, while preserving it in the durable feed. A malformed, partial, or interrupted private block must not leak into prose; framing and failure handling require deterministic tests before a live prototype.

For example, an annotation could bind “the cloaked visitor” to an existing UID, preserve an unspoken agenda, correct an earlier assertion, or request preparation of a future record. Ordinary visible actions need no duplicate maintenance handoff. A staging request is intent until its specified outcome actually becomes established. The engine owns delivery identifiers, causal provenance, retry identity, and ordering; the model writes meaningful freeform content rather than inventing protocol IDs.

The co-DM can return a freeform mailbox message to the DM. The engine injects pending messages into **VOLATILE** per-turn context, outside the stable scene prefix. Delivery bookkeeping is engine-owned, not an acknowledgement conversation: the DM need not reply or acknowledge each message. Durable mailbox records and delivery state must survive interruption without silently losing useful corrections, while rollback must invalidate messages from abandoned history. The exact replay/delivery policy remains to be selected.

## Scheduling and consistency

There is one serialized co-DM lane. While it runs, events accumulate. When it is ready, the engine batches **all pending completed exchanges into one co-DM user message**, preserving intermediate event order. It does not invoke once per event or rely on a timer. A busy lane may therefore receive several exchanges together; batching must retain intermediate custody changes, tool failures, corrections, and reveals rather than reduce them to final prose alone. The co-DM can batch independent maintenance actions and retains its conversation within the scene. Its own writes/results remain in that conversation and may inform later input, but must not independently wake its own lane: no self-triggering feedback loop or acknowledgement ping-pong.

Each agent begins the scene with a frozen compact campaign tree and stable identity handles. Metadata refers to the same canonical UID through a rename or secret reveal. New facts and corrections arrive through conversation/feed/volatile feedback; the stable scene prefix is never rewritten midscene for these updates. Fresh canonical facts require an explicit read rather than the assumption that the snapshot refreshed.

The current engine [settles deferred lanes at ordinary turn boundaries](../../../packages/engine/src/agents/game-engine.ts), as well as lifecycle barriers. Ordinary turns in this proposal must stop globally draining the co-DM lane or the foreground path still waits on bookkeeping. This introduces a real unresolved dependency: a DM `knowledge` read may require a fact whose observation the lane has not yet committed. The prototype must choose and document a freshness policy, such as a targeted watermark barrier for dependent reads, or an explicit response exposing committed state plus pending observations. It must never silently return stale state as fresh or bypass authoritative mechanics. Presentation writes also need a revision/causal guard so an older co-DM result cannot overwrite newer foreground intent; the exact guard is open.

## Lifecycle and recovery requirements

Lifecycle ownership includes **all entry points**, not only DM tools: slash commands, OOC/Dev surgery, menu shutdown, startup, manual saves and restore/picker paths. They must share the engine's fences and durable mutation protocol. Mechanical resource changes, specialist sheet replacements and canonical updates must advance revisions at the actual write boundary. Observing only presentation-tool calls is insufficient. Successful tool dispatch, successful underlying mutation and completed asynchronous asset work are distinct feed events.

On scene transition, close the current exchange and establish a watermark. Drain both the foreground work queue and co-DM queue through that watermark before capturing an atomic, recovery-safe snapshot. Only then clear/rebuild the two scene contexts and capture the next frozen tree. Events created during closure must belong to a defined side of the cut. Scene summaries and other existing helpers are part of the barrier/accounting rather than assumed free work.

Rollback must invalidate abandoned queued events, in-flight writes, mailbox messages, and asynchronous presentation results before they can mutate restored state. A generation/epoch guard or equivalent is needed even if waiting is used. Save/reload must retain pending events, the consumed cursor, delivery state, and enough continuing context to resume deterministically, or explicitly drain before saving. An in-memory queue alone is insufficient. Crash/retry handling must prevent duplicate history, repeated portrait work, lost observations, and partially closed scenes. These are requirements for the experiment; no new storage schema is specified here.

## Campaign start and specialist integration

Campaign start has its own private bootstrap event. After accepted setup is committed into a minimal deterministic scaffold, both principal conversations receive the same canonical handles, accepted choices, seed/fork provenance, boundaries, approved portrait, private handoff letter, opening directive and task status. The DM authors the opening; the co-DM can begin routine initialization immediately. The initial sheet specialist may overlap independent narration, but any dependent mechanical action waits for its accepted result. A proposed opening is not an observed event. Preserve setup/game provider-disposal ordering and distinguish startup instructions from player speech.

Startup progress must distinguish scaffold ready, opening in progress/delivered, required mechanics ready and background jobs pending. Keys and values initialize the resource display together; authoritative snapshots preserve newer background updates. Reload resumes the same startup operation instead of replaying an opening or paid render. See the [startup analysis and measured baseline](agent-tool-audit.md#campaign-start-integration).

Most specialists remain: combat resolution stays on the dependent foreground path; theme styling follows co-DM maintenance; choice generation and AI players retain strictly player-safe input; summarization, compendium and recap remain bounded closing helpers. The co-DM owns event history during play, so closing changelogs must not duplicate it. Public disclosure uses one canonical publication protocol shared with the compendium helper. Derived trackers/precis remain hints, not a second source of authoritative facts. Their remaining latency and usage must still be measured.

The normal co-DM replaces explicit **and automatic** scribe invocations, including indirect operator handoffs. Its limited capability set adds bounded campaign-history retrieval and established-objective recording to maintenance, profile, theme, portrait and shared display tools; it does not gain dice, decks, scene cuts, scene images or narrative authority. Full per-tool ownership and dependencies are in the [disposition matrix](agent-tool-audit.md#complete-registered-tool-disposition). Production routing gets an explicit co-DM role/model/effort setting rather than the experiment's hardcoded defaults.

## Prompt migration preserves earned guidance

Migration is an obligation audit against the **effective** prompts, not a generic shorter rewrite. Preserve seed/personality top-level overrides and model conditionals. [Prompt loading](../../../packages/engine/src/prompts/load-prompt.ts) resolves includes/conditionals and strips `%%` and HTML comments; commented-out rules must not accidentally become active again. Co-DM factual maintenance must remain reliable when the DM personality intentionally distorts narration.

| Existing guidance | Proposed destination |
|---|---|
| [DM identity](../../../packages/engine/src/prompts/dm-identity.md): authorial presence and enjoyment; [DM directives](../../../packages/engine/src/prompts/dm-directives.md) `<roles>`: player/DM authorship split | Foreground DM, substantially intact |
| World autonomy, honest consequences, secrets/NPC knowledge limits, private oracle rolls, pacing, personality, prose and formatting | Foreground DM |
| Narrative scene-cut craft and raw pacing cues | Foreground DM; never replace with pressure to cut for compaction |
| Scribe identity/UID resolution, aliases/consolidation, typed current facts versus history, custody/location consistency | Co-DM |
| Reading complete existing bodies/public summaries before replacement; preserve unrelated biography, inventory, and secrets | Co-DM |
| Explicit visibility/disclosure; one canonical identity through a secret reveal; safe public names/summaries | Co-DM |
| Dependency notices are candidates, not automatic deaths/quest failures; observed spell behavior is not invented mechanics | Co-DM, with DM retaining consequence decisions |
| Machine-scope player profiles and append-only Content Boundaries | Preserve existing scope and factual append-only protections |
| Portrait persistence/silence and theme maintenance | Co-DM |
| All scene-image obligations and campaign/seed art-direction overrides | Foreground DM |
| Routine display maintenance plus expressive custom keys | Shared capability with the ownership/ordering rule above |

Repository history explains why this audit matters: `d9b468a3` (#527) removed the obsolete `docs/dm-prompt.md`; `cfa1d3bf` tried outcome-style directives, followed by `4e2d3c8a` (#443) restoring the authorship anchor; `844f7292` (#764) reduced standing obligations; `b2582fe7` (#744) separated scene cuts from compaction pressure. These are historical context, not an invitation to revive older rules. Current prompt files are the source of truth.

## Bounded experiment and open decisions

The datafeed concept is model-independent. The first real test uses a **Sol 6.1 DM at medium reasoning effort**, with the co-DM initially **Sol 6.1, explicitly configured**. Compare against the current Sol DM + Luna scribe arrangement; freeze both configurations and effective prompts in the evidence. The architecture is now selected; further experiments guide hardening and optimization rather than reopening that decision. See the [test plan](test-plan.md) for fixtures, failure gates, and measurement.

The proposed portable fixtures are [initial state](fixtures/initial-state.json), [ordered events](fixtures/events.json), [withheld oracle](fixtures/oracle.json), and [protocol cases](fixtures/protocol-cases.json). These are experiment inputs and expectations, not existing production API formats or completed test results.

Count total uncached input, cache reads/writes, output including reasoning, retries, and **all helpers** across the full workload. Two roles do not imply lower cost, and asynchronous response delivery does not imply less total work. Measure player-visible latency separately from queue completion and lifecycle drain latency. Preserve narrative quality, authorship, identity/privacy correctness, recovery, and freshness before interpreting savings.

The prototype makes concrete choices for private framing, dependent-read freshness, presentation revision guards, and durable context/mailbox/cursor behavior. The tested boundaries and remaining recovery gaps are described above; the intended evaluation remains broader than a first pilot.

Related current references: [context management](../../context-management.md), [subagent contracts](../../subagents-catalog.md), [image generation](../../image-generation.md), [tool contracts](../../tool-input-contracts.md), [recovery](../../error-recovery.md), and the earlier [dependency bookkeeping screen](../metadata-dependencies/README.md).
