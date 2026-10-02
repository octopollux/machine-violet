import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

// Oracle is deliberately separate from every agent-facing prepared prompt.
// Schema: {requiredEdges:[[dependent,target]],forbiddenEdges:[[dependent,target]],
// notices:[ids],requiredChanged:[ids],forbiddenChanged:[ids],requiredHandled:[ids],
// typedValues:[{id,path:[keys],value:JSON value}],semanticReview:[strings]}.
export function score(result, oracle) {
  const entities = new Map(result.state.entities.map((e) => [e.id, e]));
  const edges = new Set(result.state.entities.flatMap((e) => e.depends_on.map((l) => `${e.id}:${l.target}`)));
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });
  for (const [from, to] of oracle.requiredEdges ?? []) check(`required edge ${from}->${to}`, edges.has(`${from}:${to}`));
  for (const [from, to] of oracle.forbiddenEdges ?? []) check(`forbidden edge ${from}->${to}`, !edges.has(`${from}:${to}`));
  for (const [field, actual] of [['Changed', result.diagnostics.declaredChanged], ['Handled', result.diagnostics.handled]]) {
    for (const id of oracle[`required${field}`] ?? []) check(`required ${field.toLowerCase()} ${id}`, actual.includes(id));
    for (const id of oracle[`forbidden${field}`] ?? []) check(`forbidden ${field.toLowerCase()} ${id}`, !actual.includes(id));
  }
  for (const expected of oracle.typedValues ?? []) {
    let actual = entities.get(expected.id)?.data;
    for (const key of expected.path) actual = actual?.[key];
    check(`typed value ${expected.id}.${expected.path.join('.')}`, isDeepStrictEqual(actual, expected.value));
  }
  let noticeMetrics = null;
  if (oracle.notices) {
    const expected = new Set(oracle.notices); const actual = new Set(result.notices.map((n) => n.dependent));
    const truePositives = [...actual].filter((id) => expected.has(id)).length;
    const falsePositives = [...actual].filter((id) => !expected.has(id));
    const falseNegatives = [...expected].filter((id) => !actual.has(id));
    noticeMetrics = { truePositives, falsePositives, falseNegatives, precision: actual.size ? truePositives / actual.size : null, recall: expected.size ? truePositives / expected.size : null, overflow: result.overflow };
  }
  return { checks, deterministicPassed: checks.filter((c) => c.ok).length, deterministicTotal: checks.length,
    noticeMetrics, semanticReviewRequired: oracle.semanticReview ?? [], overallPass: null };
}
if (process.argv[1]?.endsWith('score.mjs')) {
  const [resultFile, oracleFile, stage] = process.argv.slice(2);
  try {
    if (!resultFile || !oracleFile) throw new Error('Usage: score.mjs <diagnostics.json> <oracle.json> [stage]');
    const result = JSON.parse(await readFile(resultFile, 'utf8')); const oracle = JSON.parse(await readFile(oracleFile, 'utf8'));
    console.log(JSON.stringify(score(result, stage ? oracle[stage] : oracle), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
