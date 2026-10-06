# Production co-DM validation

The production follow-through to [#792](https://github.com/octopollux/machine-violet/issues/792)
was exercised through the real launcher and `/play` harness. This report describes
one quality run, not a statistical reliability or cost-parity result. The primary
agent played each turn; separate read-only audits checked the resulting campaign.

The DM and continuing co-DM used the OpenAI API-key provider, Sol 6.1 at medium
effort. Small helpers used Luna. Images remained enabled. Provider request dumps
confirmed the routed models and efforts, rather than inferring them from settings.

## Baked campaign

The Long Patience completed its opening and twelve player turns across three
scenes, including at least three turns after each natural scene change. Two
graceful reloads validated with zero errors or warnings. OOC corrections, manual
save, normal menu teardown, portraits, and asynchronous scene images were exercised.

Canonical-state checks established:

- Stable identities and custody; the delivery watch remained concealed and
  unopened, with its unseen photograph still unverified.
- An offered job did not become accepted until the player accepted it. Its
  deadline, recipient-only handover, fallback return and exact message survived.
- A quoted room price did not become a reservation, deposit or expense. The
  player's invented cousin cover story did not become a real relative.
- The delivery advance, actual fare and playful Swear Jar stayed distinct.
  Fate resources and `PROMISES TO KEEP: 2` survived reload and maintenance.
- The accepted delivery appeared once in the objective tracker. Known private
  seed anchors were absent from public scene summaries; this is a targeted
  disclosure check, not proof against every possible semantic leak.
- SQLite integrity was `ok`, with no foreign-key violations. The final lane
  reached cursor 22 with no pending exchanges or active batch, including the
  final image-completion observation.

The live run exposed and prompted fixes for a player-profile contract mismatch,
private OOC control frames reaching streamed output, an omitted objective prompt
obligation, and objective listing incorrectly invalidating the following create.
Those fixes received targeted regressions and subsequent live verification.

## Custom campaign

A separate custom Fate Accelerated mystery, Lantern House, completed setup,
opening and two player turns. All 18 scaffold identities still resolved after
initialization; the starting-location placeholder was renamed using its existing
UID. The accepted handoff, custom provenance, content boundaries and approved
portrait reached the startup envelope. Scaffold, mechanics and opening statuses
became ready/ready/delivered. The sheet contained the accepted approaches,
refresh/Fate points, stress and unchosen-stunt status.

The DM, co-DM and Small sheet-generation requests overlapped, with the sheet
finished before the DM continuation. The named keeper remained a letter contact;
neither the opening nor maintenance invented a meeting or chose the player's
first investigation. Subsequent play distinguished a boat operator's testimony
from directly observed water conditions. In the actual terminal, background
search/write glyphs accrued while the player input prompt remained available.
After save and graceful menu exit, SQLite integrity and foreign keys were clean,
and the co-DM had consumed all six accepted observations with no pending work.

Final confirmation to first opening text was bounded at 100.949 seconds, and
input readiness at 109.902 seconds. Of that, 89.667 seconds preceded the opening
input during setup finalization; opening-input to first text/readiness was
11.282/20.235 seconds. The setup acknowledgment is excluded from first opening
text. These are polling bounds, and the full confirmation wait is retained.

One setup behavior remains worth tuning: it generated a portrait after an
initial “no portrait needed” request followed by enabling images. The player
subsequently inspected and explicitly approved that portrait before handoff.
This run therefore verifies approved-portrait preservation, not portrait opt-out.

## Timing and accounting

Ten ordinary player turns took approximately 8–34 seconds from recorded action
arrival to completed DM exchange, with a median of about 15 seconds. This includes
CLI/server admission time. The two scene-transition exchanges took approximately
116 and 84 seconds, including maintenance and closing work. Final confirmation
to completed opening exchange was 72.233 seconds. These are distinct boundaries;
the earlier exchanges do not have exact UI readiness timestamps.

For the final three ordinary turns, a read-only observer separately sampled the
first public DM text change and open input readiness:

| Turn | First public text (s) | Input ready (s) |
| --- | ---: | ---: |
| 10 | 18.216 | 27.227 |
| 11 | 6.678 | 14.100 |
| 12 | 2.316 | 8.330 |

These are upper bounds from 100 ms polling, including fetch lag. Earlier first-text
timings cannot be reconstructed. This run is not a paired comparison with the old
architecture and does not establish a percentage speedup.

Usage analysis counts leaf API spans, not aggregate agent spans or usage callback
counts. Reused span IDs across process restarts are namespaced by session and
source record. Cached input and reasoning diagnostics are not added twice, and
overlapping API wall times are not summed into player latency. Setup tape usage
is accounted separately from gameplay traces. Image jobs have no captured
billable usage or configured price, so a complete dollar total is unavailable.
Cost parity remains future tuning work.

The main run's captured 119 gameplay/helper API calls and 12 setup calls cost an
estimated $1.649529 in text inference at the repository's configured rates:
co-DM $0.929946, DM $0.470904, OOC $0.119929, setup $0.126011, and Small helpers
$0.002737. This excludes image charges and any failure without recorded usage;
it is not the complete bill. The co-DM remains the largest measured text cost.

## Evidence and limits

Private evidence is retained under `.batch-runs/co-dm-production-20261005/`:
campaigns, recorded tapes, timing observations, `quantitative.md`/`.json`,
`semantic-audit.md`, and check logs. These contain private campaign/model context
and are intentionally excluded from source control.

The final code gate passed 4,115 tests across 238 files, with 14 skipped tests;
lint, TypeScript builds, Campaign Explorer typecheck and the golden replay gate
also passed. Golden verification reported 14 passed and 14 skipped. The recorded
live tapes are evidence, not a newly claimed deterministic full-stack corpus.

[Production acceptance coverage](../../co-dm.md#acceptance-coverage) links the
deterministic race, replay, ownership and startup regressions. The live run does
not simulate every interruption point. Unknown paid-render outcomes require
reconciliation, and perpetual provider failure cannot promise a bounded pending
queue. Long-context compaction is covered by deterministic regressions rather
than a live hundred-turn single-scene campaign.
