# Narrative dependency bookkeeping: exploratory feasibility screen

2026-10-02. **Proceed to a controlled prototype, with changes to the maintenance interface before trusting it.** The small agents recorded enough dependencies for the deterministic runner to produce every expected impact notice in the five-stage sequence, but some omitted or erased other valid dependencies and retained contradictory old facts. This is an initial exploration, not production validation. No production behavior or game prompts changed.

## Method and evidence

Three independent five-stage sequences used actual `gpt-6-luna` subagents at medium reasoning effort. Each stage received the same shared instructions and story, plus its run's evolving state. The fixture contained 14 opaque-ID records, arbitrary JSON data, and reason-bearing dependency lists. Data shallow-merged; supplied dependency lists replaced the whole list. The runner validated each complete batch atomically, computed reverse dependency candidates to depth two, retained old links during retrieval, and suppressed explicitly handled destinations. It never inferred or applied narrative consequences.

The sequence tested initial reliance versus mere mention, escaped characters and ended commitments, a cosmetic castle rename, uncertain fire outcomes, explicitly resolved consequences, replacement quest requirements, duplicate-face card identity, a contradicted death rumor, ambiguous place naming, and a failed tool result. Frozen [story fixtures](fixtures/stages.json), [instructions](fixtures/agent-instructions.txt), [oracle](fixtures/oracle.json), [scored summary](summary.json), and [runner notes](runner-notes.md) preserve the method. Each accepted stage saves raw output, before/after state, and diagnostics under [run A](results/luna-a/), [run B](results/luna-b/), and [run C](results/luna-c/). Oracle expectations were withheld from the agents.

## Results

| Run | Frozen deterministic checks | Stage 3 fire candidates | Stage 4 candidates | Stage 5 testimony candidates |
|---|---:|---|---|---|
| A, recovered | 48/48 | Archive, Tamsin, succession quest | None | Succession quest |
| B | 47/48 | Archive, Tamsin, succession quest | None | Succession quest |
| C | 46/48 | Archive, Tamsin, succession quest | None | Succession quest |

Stage 3 and 5 candidate precision and recall were 1.0 in all runs, with no overflow. Stage 4 had no expected or emitted candidates, so precision/recall are undefined rather than a numerical success rate. These deterministic checks cover selected edges, typed values, declarations, and notices; they do not constitute semantic passes.

All runs preserved fire uncertainty until explicit resolution, retired existing rescue/grain and departed-character castle links (C never recorded Elian's castle link), replaced succession/parley dependencies, preserved the baseline typed values, recorded card `c02` rather than the other Flame copy, left engine-owned deck data unchanged, retained possession after the rejected return, kept Iona alive, and declined ambiguous abandonment.

Independent snapshot review found consequential maintenance failures:

- **A accumulated conflicting facts.** Elian remained `imprisoned` in the dungeon alongside escape and Inn residence. Mara still `serves` and `lives` in the castle garrison alongside permanent Lodge transfer and no castle commitments. Iona remained `staying` at the Lodge alongside flight to a safe house. The succession quest still `requires` the deed alongside an abandoned deed route and testimony replacement. Redundant records also retained castle features saying the dungeon imprisons Elian, and an Archive field saying the destroyed deed is stored there. See [A stage 5 state](results/luna-a/stage5/after.json).
- **B erased still-valid links during unrelated updates.** Recording Elian's card/fainting replaced his Inn dependency with `[]`; adding Mara's parley authentication replaced her Lodge dependency with `[]`. Residence facts remained. The five-stage sequence did not include subsequent Inn/Lodge changes; the separate hypothetical probes below test the resulting missing notices. See [B stage 4 output](results/luna-b/stage4/raw.json) and [stage 5 output](results/luna-b/stage5/raw.json).
- **B retained stale facts too.** Elian's imprisonment and Iona's Lodge stay survived their moves. The castle record still described Elian imprisoned and Rowan's grain contract ongoing after both ceased. B omitted Tamsin from `handled` at stage 4: a bookkeeping miss, but no repeated reminder occurred because that batch did not declare the castle changed.
- **C omitted Elian's castle dependency initially and never added his Inn dependency.** It reconciled his imprisonment and Iona's location more cleanly, but renamed the castle without preserving the old-name alias. See [C stage 2 state](results/luna-c/stage2/after.json). Its boolean `garrisonOperating` and `drainageTunnelUsable` later became string `unknown after fire`: an optional future type-policy question, not a frozen failure.

All completed rescue records retained old requirement fields; completed status and empty dependencies make their inactivity explicit. Whether those fields are history or stale current claims remains ambiguous. The report does not count them as surviving active rescue links.

Separately labelled post-hoc read-only counterfactual probes of final states confirmed missing Elian candidates for an Inn change in B/C and missing Mara plus the depth-two parley candidate for a Lodge change in B; A retrieved both expected sets, and C retrieved the Lodge set. These hypothetical probes were computed after scoring without state persistence: they are not additional Luna stages or frozen scores, and are saved in [summary.json](summary.json).

## JSON failure and context audit

There were 15 stage-level first attempts: 14 accepted and A's first rejected. One exact-parser-feedback repair succeeded, giving 16 total attempts and 15 accepted batches. A then completed the remaining four stages. Preserve the [original raw rejection](results/luna-a/stage1/raw.json) and [parser diagnostic](results/luna-a/stage1/rejected.json) separately from [recovered stage 1](results/luna-a/stage1-retry1/raw.json). These small, selected counts do not estimate population reliability.

The coordinator inspected local subagent session logs. A's failing generation had 37,288 input tokens against a runtime-reported 258,400-token window and 969 output tokens including reasoning. The malformed interior was already present in the original custom exec/apply_patch call, with a complete ending; no truncation, compaction, or runtime error explained it. Maximum later inputs were A 57,848, B 55,612, and C 54,940, with no compaction or truncated tool outputs. Private session IDs and full logs are not stored here.

Fresh forks excluded prior chat but retained generic Codex instructions/tools: A had approximately 35,834 input tokens before its first fixture. That is artificial harness overhead. The inner JSON was raw text in a patch, not constrained JSON tool arguments. This failure therefore does not demonstrate production structured-output reliability. A prototype should use an executable structured tool schema; [OpenAI's Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) describes that mechanism. Schema conformity still cannot ensure semantic correctness.

## Prototype boundary

Whole-list replacement creates an avoidable preservation hazard: B cleared unrelated links while updating another fact. Test individual dependency add/remove patches or require explicit preservation review before replacement. Also test reconciliation of superseded fields and redundant facts. These are bounded maintenance-interface changes, not a reason to redesign the whole ontology.

The pre-applied successful/failed deck snapshots tested bookkeeping around tool facts, not deck implementation. This screen did not test a live Machine Violet DM, player-facing behavior, long-context retrieval, production schema constraints, restart recovery, or a real token-cost comparison. Nine runner invariant tests passed. A controlled prototype should exercise those boundaries and actual Luna responses to Inn/Lodge events before any stronger claim.
