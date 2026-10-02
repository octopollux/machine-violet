import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { score } from './score.mjs';
import { applyBatch } from './runner.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const read = async (...parts) => JSON.parse(await readFile(path.join(base, ...parts), 'utf8'));
const oracle = await read('fixtures', 'oracle.json');
const runs = {};
for (const run of ['a', 'b', 'c']) {
  const stages = {};
  for (let number = 1; number <= 5; number++) {
    const stage = `stage${number}`;
    const actualStage = run === 'a' && number === 1 ? 'stage1-retry1' : stage;
    stages[stage] = { source: actualStage, ...score(await read('results', `luna-${run}`, actualStage, 'diagnostics.json'), oracle[stage]) };
  }
  const finalState = await read('results', `luna-${run}`, 'stage5', 'after.json');
  const postHocProbes = {};
  for (const [label, target, expected] of [['inn', 'e03', ['e05', 'e14']], ['lodge', 'e04', ['e06', 'e10']]]) {
    const result = applyBatch(finalState, { updates: [], changed: [target], handled: [], notes: [] });
    postHocProbes[label] = { hypotheticalChanged: target, expectedCandidates: expected, actualCandidates: result.notices.map((n) => n.dependent), ...score(result, { notices: expected }).noticeMetrics, notices: result.notices };
  }
  runs[run] = { stages, deterministicPassed: Object.values(stages).reduce((sum, s) => sum + s.deterministicPassed, 0), deterministicTotal: Object.values(stages).reduce((sum, s) => sum + s.deterministicTotal, 0), postHocProbes };
}
const summary = {
  scope: 'Frozen deterministic oracle plus independent snapshot semantic review; no overall pass assigned.',
  originalRejection: { run: 'a', stage: 'stage1', ...await read('results', 'luna-a', 'stage1', 'rejected.json'), recoveredStage: 'stage1-retry1', provenance: 'Coordinator verified malformed text present in original call; no compaction/truncation; see README.' },
  postHocProbeScope: 'Read-only hypothetical inn/lodge changes against final snapshots, after frozen scoring; not additional Luna stages or preregistered scores. No state persisted.',
  runs,
  semanticFindings: [
    { run: 'a', severity: 'failure', stages: [2, 3, 4, 5], facts: ['Castle.features still says dungeon imprisons Elian after his escape.', 'Archive.successionDeed still says unique signed deed stored here after archive and deed are confirmed destroyed.'], implication: 'Related records accumulate stale facts alongside later resolutions.' },
    { run: 'b', severity: 'failure', stages: [2, 3, 4, 5], facts: ['Castle.ElianImprisoned remains dungeon after Elian escapes.', 'Castle.grainContract remains ongoing after Rowan contract ends.'], implication: 'Related records retain superseded facts despite primary character updates.' },
    { run: 'c', severity: 'failure', stages: [2, 3, 4, 5], facts: ['Castle rename retains e01 identity but no old-name alias is recorded.'], implication: 'Stage5 ambiguity is still handled correctly in notes; loss of explicit alias is a distinct identity metadata miss.' },
    { run: 'a', severity: 'failure', stages: [2, 3, 4, 5], facts: ['Elian.imprisoned remains Blackthorn Castle dungeon after escape and current Lantern Inn stay.', 'Mara.serves and Mara.lives remain castle garrison after permanent Lodge transfer and castleHomeDutiesCommitments=false.', 'Iona.staying remains Blackthorn Lodge after flight to an undisclosed safe house.', 'Succession.requires remains the unique deed after originalDeedRoute=abandoned and testimony route replacement.'], source: 'Each listed value persists through corresponding after.json snapshots.' },
    { run: 'b', severity: 'failure', stages: [4, 5], facts: ['Stage4 Elian.depends_on replaces the existing e03 inn edge with []; current staysAt=e03 remains.', 'Stage5 Mara.depends_on replaces the existing e04 lodge edge with [] during a parley authentication update; current resides=e04 remains.'], implication: 'Unrelated updates erase still-valid dependencies. No subsequent inn/lodge event tests the resulting missed notices.' },
    { run: 'b', severity: 'failure', stages: [2, 5], facts: ['Elian.imprisoned remains dungeon of e01 after escape.', 'Iona.stayingAt remains e04 after location records flight to an undisclosed safe house.'] },
    { run: 'b', severity: 'bookkeeping_miss', stages: [4], facts: ['Handled omits Tamsin e14 despite explicit resolution of her fire outcome.'], implication: 'Not an observed repeated-notice failure: stage4 did not declare castle e01 changed, and emitted zero notices.' },
    { run: 'c', severity: 'failure', stages: [1, 2, 3, 4, 5], facts: ['Elian has no dependency on castle e01 in stage1 despite imprisonment there.', 'Elian never gains dependency on inn e03 after moving there in stage2.'], implication: 'Missing dependencies do not degrade the tested fire query because Elian has already escaped; an inn event was not tested.' },
    { run: 'all', severity: 'review_caution', stages: [2, 3, 4, 5], facts: ['Completed rescue quest retains old requires/needs fields in all runs; status and empty dependencies make inactivity explicit, so stale historical requirement versus contradiction is ambiguous.'], implication: 'Do not claim active rescue dependencies remain; they were retired correctly.' },
    { run: 'all', severity: 'success', stages: [3, 4, 5], facts: ['All runs emit exactly e02/e14/e09 candidates at fire stage3, no stage4 candidates, and only e09 at stage5.', 'All preserve unknown fire outcomes until explicitly resolved; existing castle dependencies for departed characters and ended rescue/grain commitments are retired before the fire (C never recorded Elian castle dependency).', 'All preserve typed baseline fields, record c02 identity, leave engine deck unchanged, retain possession after failed return, reject ambiguous abandonment, and keep Iona alive.'] },
  ],
};
await writeFile(path.join(base, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ totals: Object.fromEntries(Object.entries(runs).map(([r, v]) => [r, `${v.deterministicPassed}/${v.deterministicTotal}`])), notices: Object.fromEntries(Object.entries(runs).map(([r, v]) => [r, [3, 4, 5].map((n) => v.stages[`stage${n}`].noticeMetrics)])) }, null, 2));
