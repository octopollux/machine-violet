import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch } from './runner.mjs';
import { score } from './score.mjs';

const state = () => ({ entities: [
  { id: 'a', name: 'Gate', data: { open: false, count: 2, details: { x: 1 } }, depends_on: [] },
  { id: 'b', name: 'Watch', data: {}, depends_on: [{ target: 'a', reason: 'Tracks gate access' }] },
] });
const batch = (extra = {}) => ({ updates: [], changed: [], handled: [], notes: [], ...extra });
test('validates the entire batch before any mutation', () => {
  const original = state(); const snapshot = structuredClone(original);
  assert.throws(() => applyBatch(original, batch({ updates: [{ id: 'a', data: { open: true } }, { id: 'missing' }] })));
  assert.deepEqual(original, snapshot);
});
test('preserves JSON types, shallow merges data, and replaces dependency lists', () => {
  const original = state();
  const result = applyBatch(original, batch({ updates: [{ id: 'a', data: { open: true, details: null } }, { id: 'b', depends_on: [] }], changed: ['a'] }));
  assert.deepEqual(result.state.entities[0].data, { open: true, count: 2, details: null });
  assert.deepEqual(result.state.entities[1].depends_on, []);
  assert.deepEqual(result.notices, [{ dependent: 'b', candidateOnly: true, paths: [{ target: 'a', path: ['a', 'b'], reasons: [['Tracks gate access']], removed: true }] }]);
  assert.equal(original.entities[0].data.open, false);
});
test('changed does not suppress consequences; handled does', () => {
  assert.equal(applyBatch(state(), batch({ changed: ['a'], updates: [{ id: 'b', data: { reviewed: true } }] })).notices.length, 1);
  assert.equal(applyBatch(state(), batch({ changed: ['a', 'b'] })).notices.length, 1);
  assert.equal(applyBatch(state(), batch({ changed: ['a'], handled: ['b'] })).notices.length, 0);
});
test('notices include new links and traverse at most two edges', () => {
  const original = state(); original.entities.push({ id: 'c', name: 'Third', data: {}, depends_on: [{ target: 'b', reason: 'Watches watch' }] });
  original.entities.push({ id: 'd', name: 'Fourth', data: {}, depends_on: [{ target: 'c', reason: 'Third hop' }] });
  assert.deepEqual(applyBatch(original, batch({ changed: ['a'] })).notices.map((n) => n.dependent), ['b', 'c']);
  assert.equal(applyBatch(original, batch({ updates: [{ id: 'c', depends_on: [{ target: 'a', reason: 'New watch' }] }], changed: ['a'] })).notices.length, 3);
});
test('handled intermediates still permit traversal, cycles terminate, and destinations deduplicate', () => {
  const original = state(); original.entities[0].depends_on = [{ target: 'b', reason: 'Cycle' }];
  original.entities.push({ id: 'c', name: 'Third', data: {}, depends_on: [{ target: 'b', reason: 'Indirect' }, { target: 'a', reason: 'Direct' }] });
  const result = applyBatch(original, batch({ changed: ['a'], handled: ['b'] }));
  assert.deepEqual(result.notices.map((n) => n.dependent), ['c']); assert.equal(result.notices[0].paths.length, 2);
});
test('readonly config rejects model updates atomically', () => {
  assert.throws(() => applyBatch(state(), batch({ updates: [{ id: 'a', data: { open: true } }] }), { readonly: ['a'] }));
});
test('bounds notices and reports overflow', () => {
  const original = state();
  for (let i = 0; i < 7; i++) original.entities.push({ id: `c${i}`, name: 'Watcher', data: {}, depends_on: [{ target: 'a', reason: 'Watch' }] });
  const result = applyBatch(original, batch({ changed: ['a'] }));
  assert.equal(result.notices.length, 5); assert.equal(result.overflow, 3);
});
test('rejects malformed fields, duplicates, and nonexistent targets', () => {
  for (const invalid of [batch({ extra: true }), batch({ changed: ['a', 'a'] }), batch({ updates: [{ id: 'b', depends_on: [{ target: 'no', reason: 'bad' }] }] }), batch({ updates: [{ id: 'a', data: [] }] })]) {
    assert.throws(() => applyBatch(state(), invalid));
  }
});
test('scoring separates edge checks, notice precision/recall, and pending semantics', () => {
  const result = applyBatch(state(), batch({ changed: ['a'] }));
  const scored = score(result, { requiredEdges: [['b', 'a']], forbiddenEdges: [['a', 'b']], notices: ['b', 'c'], typedValues: [{ id: 'a', path: ['open'], value: false }], semanticReview: ['Judge narrative'] });
  assert.equal(scored.deterministicPassed, 3);
  assert.equal(scored.noticeMetrics.precision, 1); assert.equal(scored.noticeMetrics.recall, 0.5);
  assert.deepEqual(scored.noticeMetrics.falseNegatives, ['c']); assert.equal(scored.overallPass, null);
});
